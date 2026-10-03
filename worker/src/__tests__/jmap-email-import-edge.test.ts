import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, authFetch, cleanDb, getDb } from "./helpers";
import { acct, idn, sys } from "./jmap-ids";
import { users } from "../db/auth.schema";
import { jmapBlobs } from "../db/jmap-blobs.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { readBlobBytes, resolveReadableBlob } from "../jmap/blobs";
import {
  decodeLeafBody,
  scanMimeStructure,
  type ScannedLeaf,
} from "../jmap/email-import";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";
import { executeJmapCalls } from "../jmap/http";
import { parseSubmissionId } from "../jmap/public-ids";
import { storeUpload } from "../jmap/upload";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import {
  INBOX,
  OK,
  SUBMISSION_CAPABILITY,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

// Verifier edge cases for Email/import (docs/archive/SPEC-jmap-email-import.md): hostile
// MIME, header encodings, charsets, the send-limit boundary, the on-success
// remap in less common shapes, the internal blob map's isolation, partial
// failures, and what an imported draft actually delivers.

type Responses = [string, Record<string, any>, string][];

const OTHER = "privacy@saasmail.test";
const CRLF = "\r\n";
const MiB = 1024 * 1024;

const encode = (text: string) => new TextEncoder().encode(text);
const lines = (...parts: string[]) => parts.join(CRLF);

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return (btoa(binary).match(/.{1,76}/g) ?? []).join(CRLF);
}

/** Deterministic PRNG (mulberry32), so a failing case can be replayed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rand: () => number, length: number): Uint8Array {
  return Uint8Array.from({ length }, () => Math.floor(rand() * 256));
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function uploadBytes(userId: string, bytes: Uint8Array) {
  const result = await storeUpload(getDb(), env, {
    userId,
    accountId: acct(userId),
    contentType: "message/rfc822",
    declaredLength: bytes.byteLength,
    body: new Response(bytes as Uint8Array<ArrayBuffer>).body,
    maxBytes: 50 * MiB,
  });
  return result.blob!.blobId;
}

const uploadRaw = (userId: string, raw: string) =>
  uploadBytes(userId, encode(raw));

async function addOtherInbox() {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: OTHER,
    displayName: "Privacy",
    createdAt: now,
    updatedAt: now,
  });
}

function importOf(
  blobId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    blobId,
    mailboxIds: { [sys(INBOX, "drafts")]: true },
    keywords: { $draft: true, $seen: true },
    ...overrides,
  };
}

function importCall(
  userId: string,
  emails: Record<string, unknown>,
): [string, Record<string, unknown>, string] {
  return ["Email/import", { accountId: acct(userId), emails }, "i"];
}

async function importOne(
  userId: string,
  item: Record<string, unknown>,
  options: { sender?: ReturnType<typeof recordingSender>["sender"] } = {},
) {
  const res = (await jmapCall(
    userId,
    [importCall(userId, { m1: item })],
    options,
  )) as Responses;
  return res[0][1];
}

async function getEmail(userId: string, id: string) {
  const res = (await jmapCall(userId, [
    [
      "Email/get",
      {
        accountId: acct(userId),
        ids: [id],
        properties: [
          "id",
          "mailboxIds",
          "keywords",
          "from",
          "to",
          "cc",
          "subject",
          "bodyValues",
          "textBody",
          "htmlBody",
          "attachments",
        ],
        bodyProperties: [
          "partId",
          "blobId",
          "type",
          "name",
          "disposition",
          "cid",
          "size",
        ],
        fetchAllBodyValues: true,
      },
      "g",
    ],
  ])) as Responses;
  return res[0][1].list[0];
}

async function blobBytes(userId: string, blobId: string) {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const allowed = await resolveAllowedInboxes(db, user);
  const blob = await resolveReadableBlob(db, allowed, userId, blobId);
  expect(blob).not.toBeNull();
  return readBlobBytes(env, blob!);
}

async function snapshot(userId: string) {
  const db = getDb();
  const listed = await env.R2.list({ prefix: `jmap-content/${userId}/` });
  return {
    drafts: (await db.select().from(jmapDrafts)).length,
    content: (await db.select().from(jmapMessageContent)).length,
    blobs: (await db.select({ id: jmapBlobs.id }).from(jmapBlobs))
      .map((row) => row.id)
      .sort(),
    objects: listed.objects.map((object) => object.key).sort(),
  };
}

function headerBlock(extra: string[] = []): string[] {
  return [
    `From: Hello Team <${INBOX}>`,
    "To: Alice Example <alice@example.com>",
    "Subject: Edge case",
    "Date: Tue, 29 Sep 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    ...extra,
  ];
}

function textOf(email: Record<string, any>): string | undefined {
  const part = email.textBody?.[0];
  return part ? email.bodyValues[part.partId]?.value : undefined;
}

function htmlOf(email: Record<string, any>): string | undefined {
  const part = email.htmlBody?.find(
    (candidate: { type: string }) => candidate.type === "text/html",
  );
  return part ? email.bodyValues[part.partId]?.value : undefined;
}

// ---------------------------------------------------------------------------
// Raw scanner and decoders, without the database
// ---------------------------------------------------------------------------

describe("Email/import raw MIME scan: hostile structure", () => {
  it("refuses a multipart with a missing or empty boundary instead of guessing", () => {
    for (const contentType of [
      "Content-Type: multipart/mixed",
      'Content-Type: multipart/mixed; boundary=""',
      "Content-Type: multipart/mixed; boundary=",
    ]) {
      const raw = lines(
        contentType,
        "",
        "--",
        "Content-Type: text/plain",
        "",
        "x",
        "----",
      );
      const scan = scanMimeStructure(encode(raw));
      expect(scan.error, contentType).toMatch(/boundary/);
    }
  });

  it("splits on the longest boundary RFC 2046 allows and ignores boundary look-alikes inside a body", () => {
    // 70 characters is the RFC 2046 maximum; a longer one is refused.
    const boundary = "b".repeat(70);
    const raw = lines(
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      `not a delimiter: --${boundary}`,
      `--${boundary}x trailing text makes this body too`,
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment",
      "",
      "payload",
      `--${boundary}--`,
    );
    const bytes = encode(raw);
    const scan = scanMimeStructure(bytes);
    expect(scan.error).toBeNull();
    expect(scan.textLeaf).not.toBeNull();
    const body = new TextDecoder().decode(
      decodeLeafBody(bytes, scan.textLeaf!),
    );
    expect(body).toBe(
      lines(
        `not a delimiter: --${boundary}`,
        `--${boundary}x trailing text makes this body too`,
      ),
    );
    expect(scan.attachmentLeaves).toHaveLength(1);
    expect(
      new TextDecoder().decode(decodeLeafBody(bytes, scan.attachmentLeaves[0])),
    ).toBe("payload");
  });

  it("terminates on a nested multipart that reuses its parent's boundary", () => {
    const raw = lines(
      'Content-Type: multipart/mixed; boundary="same"',
      "",
      "--same",
      'Content-Type: multipart/mixed; boundary="same"',
      "",
      "--same",
      "Content-Type: text/plain",
      "",
      "inner",
      "--same--",
      "--same",
      "Content-Type: text/plain",
      "",
      "outer",
      "--same--",
    );
    const scan = scanMimeStructure(encode(raw));
    // Either answer is acceptable; a hang, a throw or a runaway walk is not.
    expect(scan.error === null || typeof scan.error === "string").toBe(true);
  });

  it.each([
    ["mixed case", "Content-Type: Multipart/Signed; boundary=s"],
    ["upper-case header name", "CONTENT-TYPE: MULTIPART/SIGNED; BOUNDARY=s"],
    [
      "extra parameters first",
      'Content-Type: multipart/signed; micalg="pgp-sha256"; x-extra=1; protocol="application/pgp-signature"; boundary="s"',
    ],
    [
      "folded after the type",
      lines(
        "Content-Type: multipart/signed;",
        '\tprotocol="application/pgp-signature";',
        ' boundary="s"',
      ),
    ],
    [
      "folded before the type",
      lines("Content-Type:", " multipart/signed;", ' boundary="s"'),
    ],
    [
      "x-pkcs7-mime",
      "Content-Type: Application/X-PKCS7-MIME; smime-type=signed-data",
    ],
    ["pgp-encrypted leaf", "Content-Type: application/PGP-encrypted"],
  ])("refuses signed or encrypted mail written with %s", (_label, header) => {
    const signed = lines(
      header,
      "",
      "--s",
      "Content-Type: text/plain",
      "",
      "signed",
      "--s",
      "Content-Type: application/pgp-signature",
      "",
      "sig",
      "--s--",
    );
    // Top level and nested two levels down.
    const nested = lines(
      'Content-Type: multipart/mixed; boundary="o"',
      "",
      "--o",
      'Content-Type: multipart/alternative; boundary="a"',
      "",
      "--a",
      signed,
      "--a--",
      "--o--",
    );
    for (const raw of [signed, nested]) {
      const scan = scanMimeStructure(encode(raw));
      expect(scan.error).toMatch(/Signed or encrypted/);
    }
  });

  it("reads folded and over-long (>998 octet) header lines without losing the part", () => {
    const raw = lines(
      `X-Long: ${"y".repeat(5000)}`,
      "Content-Type: multipart/mixed;",
      ' boundary="m"',
      "",
      "--m",
      "Content-Type: text/plain;",
      "\tcharset=utf-8",
      "",
      "body",
      "--m",
      "Content-Type: application/pdf;",
      `  name="${"n".repeat(1200)}.pdf"`,
      "Content-Disposition: attachment",
      "",
      "pdf",
      "--m--",
    );
    const scan = scanMimeStructure(encode(raw));
    expect(scan.error).toBeNull();
    expect(scan.textLeaf?.type).toBe("text/plain");
    expect(scan.attachmentLeaves.map((leaf) => leaf.type)).toEqual([
      "application/pdf",
    ]);
  });

  it("refuses signed mail whose Content-Type name has whitespace before the colon", () => {
    // postal-mime reads "Content-Type :" as Content-Type; the strict header
    // grammar refuses the line, so the signed part can't slip through.
    const raw = lines(
      "Content-Type : multipart/signed; boundary=s",
      "",
      "--s",
      "Content-Type: text/plain",
      "",
      "signed",
      "--s--",
    );
    const scan = scanMimeStructure(encode(raw));
    expect(scan.error).toMatch(/header name that is not printable US-ASCII/);
  });

  it("refuses, without throwing, a part with no blank line after its headers", () => {
    // The body line has no colon, so it is not a header line: the header
    // block isn't strict header lines and the message is refused.
    const raw = lines(
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      "Content-Type: text/plain",
      "Body line with no blank line above",
      "--m--",
    );
    const scan = scanMimeStructure(encode(raw));
    expect(scan.error).toMatch(/a line that is not a header/);
  });

  it("walks a 5 MiB body of boundary lines within bounds", () => {
    const junk = "--w\r\nContent-Type: application/x\r\n\r\n".repeat(
      Math.floor((5 * MiB) / 36),
    );
    const raw = lines('Content-Type: multipart/mixed; boundary="w"', "", junk);
    const started = Date.now();
    const scan = scanMimeStructure(encode(raw));
    expect(scan.error).toMatch(/more than 100 MIME parts/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("Email/import transfer decoding against a reference", () => {
  function leafFor(raw: Uint8Array, encoding: string): ScannedLeaf {
    const scan = scanMimeStructure(raw);
    expect(scan.error).toBeNull();
    const leaf = scan.attachmentLeaves[0];
    expect(leaf.encoding).toBe(encoding);
    return leaf;
  }

  function part(encoding: string, body: string): Uint8Array {
    return encode(
      lines(
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "--m",
        "Content-Type: application/octet-stream",
        `Content-Transfer-Encoding: ${encoding}`,
        "Content-Disposition: attachment",
        "",
        body,
        "--m--",
      ),
    );
  }

  it("decodes base64 with random whitespace, line lengths and junk characters byte for byte", () => {
    const rand = prng(20260929);
    for (let round = 0; round < 60; round += 1) {
      const original = randomBytes(rand, Math.floor(rand() * 700));
      const clean = b64(original).replace(/\r\n/g, "");
      let noisy = "";
      for (const char of clean) {
        noisy += char;
        const roll = rand();
        if (roll < 0.03) noisy += "\r\n";
        else if (roll < 0.05) noisy += " ";
        else if (roll < 0.06) noisy += "\t";
        else if (roll < 0.07) noisy += "!";
        else if (roll < 0.075) noisy += "\n";
      }
      const raw = part("BASE64", noisy);
      const decoded = decodeLeafBody(raw, leafFor(raw, "base64"));
      expect(Array.from(decoded), `round ${round}`).toEqual(
        Array.from(original),
      );
    }
  });

  it("decodes quoted-printable with lowercase hex, soft breaks and a trailing '=' byte for byte", () => {
    const rand = prng(42);
    for (let round = 0; round < 60; round += 1) {
      const original = randomBytes(rand, Math.floor(rand() * 400));
      let qp = "";
      let lineLength = 0;
      for (const byte of original) {
        const printable =
          byte >= 0x21 && byte <= 0x7e && byte !== 0x3d && rand() < 0.7;
        let token = printable
          ? String.fromCharCode(byte)
          : `=${byte.toString(16).padStart(2, "0")}`;
        if (!printable && rand() < 0.5) token = token.toUpperCase();
        if (lineLength + token.length > 70 || rand() < 0.02) {
          qp += rand() < 0.5 ? "=\r\n" : "= \t\r\n";
          lineLength = 0;
        }
        qp += token;
        lineLength += token.length;
      }
      qp += "=";
      const raw = part("Quoted-Printable", qp);
      const decoded = decodeLeafBody(raw, leafFor(raw, "quoted-printable"));
      expect(Array.from(decoded), `round ${round}`).toEqual(
        Array.from(original),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Through Email/import, with the database
// ---------------------------------------------------------------------------

describe("Email/import edge cases", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("keeps an 8bit UTF-8 subject and names, French and Kabiyè, without encoded-words", async () => {
    const { authorId } = await seedAccount();
    const raw = lines(
      `From: Ɛsɔ Kɔfi <${INBOX}>`,
      "To: Ŋʋ Ɖɛ <alice@example.com>, Élodie Gbéhanzin <elodie@example.com>",
      "Subject: Réunion à Kara – ɖɔɔ kɛ ŋʋ",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "Bɔnjʋʋr, ça va ?",
      "",
    );
    const blobId = await uploadRaw(authorId, raw);
    const result = await importOne(authorId, importOf(blobId));
    expect(result.notCreated).toBeNull();
    const email = await getEmail(authorId, result.created.m1.id);
    expect(email.subject).toBe("Réunion à Kara – ɖɔɔ kɛ ŋʋ");
    expect(email.from).toEqual([{ name: "Ɛsɔ Kɔfi", email: INBOX }]);
    expect(email.to).toEqual([
      { name: "Ŋʋ Ɖɛ", email: "alice@example.com" },
      { name: "Élodie Gbéhanzin", email: "elodie@example.com" },
    ]);
    expect(textOf(email)?.trimEnd()).toBe("Bɔnjʋʋr, ça va ?");
  });

  it("decodes RFC 2047 names (UTF-8 base64, ISO-8859-1 Q) in From, To and Cc", async () => {
    const { authorId } = await seedAccount();
    const utf8Name = btoa(
      String.fromCharCode(...new TextEncoder().encode("Ɛsɔ Kɔfi")),
    );
    const raw = lines(
      `From: =?UTF-8?B?${utf8Name}?= <${INBOX}>`,
      "To: =?ISO-8859-1?Q?Andr=E9_Dupr=E9?= <andre@example.com>",
      'Cc: "=?utf-8?q?L=C3=A9a?=" <lea@example.com>',
      "Subject: =?utf-8?b?w4AgYmllbnTDtHQ=?=",
      "Content-Type: text/plain",
      "",
      "x",
      "",
    );
    const blobId = await uploadRaw(authorId, raw);
    const result = await importOne(authorId, importOf(blobId));
    expect(result.notCreated).toBeNull();
    const email = await getEmail(authorId, result.created.m1.id);
    expect(email.from).toEqual([{ name: "Ɛsɔ Kɔfi", email: INBOX }]);
    expect(email.to).toEqual([
      { name: "André Dupré", email: "andre@example.com" },
    ]);
    expect(email.cc).toEqual([{ name: "Léa", email: "lea@example.com" }]);
    expect(email.subject).toBe("À bientôt");
  });

  it("converts an iso-8859-1 8bit body, top level and inside multipart, to text", async () => {
    const { authorId } = await seedAccount();
    const latin1 = (text: string) =>
      Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
    const single = concat(
      encode(
        lines(
          ...headerBlock([
            "Content-Type: text/plain; charset=iso-8859-1",
            "Content-Transfer-Encoding: 8bit",
          ]),
          "",
          "",
        ),
      ),
      latin1("Café crème à Lomé"),
    );
    const multi = concat(
      encode(
        lines(
          ...headerBlock(['Content-Type: multipart/alternative; boundary="a"']),
          "",
          "--a",
          'Content-Type: text/plain; charset="ISO-8859-1"',
          "Content-Transfer-Encoding: 8bit",
          "",
          "",
        ),
      ),
      latin1("Déjà vu"),
      encode(
        lines(
          "",
          "--a",
          "Content-Type: text/html; charset=iso-8859-1",
          "Content-Transfer-Encoding: quoted-printable",
          "",
          "<p>D=e9j=E0 vu</p>",
          "--a--",
          "",
        ),
      ),
    );
    const first = await importOne(
      authorId,
      importOf(await uploadBytes(authorId, single)),
    );
    expect(first.notCreated).toBeNull();
    expect(textOf(await getEmail(authorId, first.created.m1.id))).toBe(
      "Café crème à Lomé",
    );
    const second = await importOne(
      authorId,
      importOf(await uploadBytes(authorId, multi)),
    );
    expect(second.notCreated).toBeNull();
    const email = await getEmail(authorId, second.created.m1.id);
    expect(textOf(email)).toBe("Déjà vu");
    expect(htmlOf(email)).toBe("<p>Déjà vu</p>");
  });

  it("imports a message with no Content-Type as text/plain, top level and as a part", async () => {
    const { authorId } = await seedAccount();
    const top = lines(...headerBlock(), "", "Plain by default.");
    const nested = lines(
      ...headerBlock(['Content-Type: multipart/mixed; boundary="m"']),
      "",
      "--m",
      "",
      "Part with no headers at all.",
      "--m",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment",
      "",
      "bin",
      "--m--",
    );
    const a = await importOne(
      authorId,
      importOf(await uploadRaw(authorId, top)),
    );
    expect(a.notCreated).toBeNull();
    expect(textOf(await getEmail(authorId, a.created.m1.id))).toBe(
      "Plain by default.",
    );
    const b = await importOne(
      authorId,
      importOf(await uploadRaw(authorId, nested)),
    );
    expect(b.notCreated).toBeNull();
    const email = await getEmail(authorId, b.created.m1.id);
    expect(textOf(email)).toBe("Part with no headers at all.");
    expect(email.attachments).toHaveLength(1);
  });

  it("imports a message that is only headers (no blank line, no body) as an empty draft", async () => {
    const { authorId } = await seedAccount();
    const raw = lines(...headerBlock(), "");
    const result = await importOne(
      authorId,
      importOf(await uploadRaw(authorId, raw)),
    );
    expect(result.notCreated).toBeNull();
    const email = await getEmail(authorId, result.created.m1.id);
    expect(email.subject).toBe("Edge case");
    expect(email.to).toEqual([
      { name: "Alice Example", email: "alice@example.com" },
    ]);
    expect(textOf(email) ?? "").toBe("");
  });

  it("imports mixed CRLF and LF line endings with the attachment bytes intact", async () => {
    const { authorId } = await seedAccount();
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const raw =
      [
        `From: ${INBOX}`,
        "To: alice@example.com",
        "Subject: Mixed endings",
        'Content-Type: multipart/mixed; boundary="m"',
      ].join("\r\n") +
      "\n\n--m\nContent-Type: text/plain\r\n\r\nLine one\nLine two\r\n--m\r\n" +
      "Content-Type: image/png\nContent-Transfer-Encoding: base64\n" +
      'Content-Disposition: attachment; filename="p.png"\r\n\n' +
      b64(png) +
      "\n--m--\r\n";
    const result = await importOne(
      authorId,
      importOf(await uploadRaw(authorId, raw)),
    );
    expect(result.notCreated).toBeNull();
    const email = await getEmail(authorId, result.created.m1.id);
    expect(textOf(email)).toBe("Line one\nLine two");
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0].name).toBe("p.png");
    expect(await blobBytes(authorId, email.attachments[0].blobId)).toEqual(png);
  });

  it("imports a message just under 5 MiB byte-identical and refuses one byte over the limit, storing nothing", async () => {
    const { authorId } = await seedAccount();
    const { sender } = recordingSender(OK);
    sender.maxAttachmentBytes = () => 5 * MiB;
    const payload = randomBytes(prng(7), Math.floor(3.5 * MiB));
    const head = lines(
      ...headerBlock(['Content-Type: multipart/mixed; boundary="big"']),
      "",
      "--big",
      "Content-Type: text/plain",
      "",
      "Big file attached.",
      "--big",
      'Content-Type: application/octet-stream; name="big.bin"',
      'Content-Disposition: attachment; filename="big.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      "",
    );
    const raw = encode(head + b64(payload) + CRLF + "--big--" + CRLF);
    expect(raw.byteLength).toBeLessThan(5 * MiB);
    const ok = await importOne(
      authorId,
      importOf(await uploadBytes(authorId, raw)),
      { sender },
    );
    expect(ok.notCreated).toBeNull();
    const email = await getEmail(authorId, ok.created.m1.id);
    const bytes = await blobBytes(authorId, email.attachments[0].blobId);
    expect(bytes!.byteLength).toBe(payload.byteLength);
    expect(bytes!.every((byte, i) => byte === payload[i])).toBe(true);

    await cleanDb();
    await seedAccount();
    const tooBig = concat(
      encode(lines(...headerBlock(), "", "")),
      new Uint8Array(5 * MiB).fill(0x61),
    );
    const blobId = await uploadBytes(authorId, tooBig);
    const before = await snapshot(authorId);
    const refused = await importOne(authorId, importOf(blobId), { sender });
    expect(refused.notCreated.m1.type).toBe("tooLarge");
    expect(await snapshot(authorId)).toEqual(before);
  });

  it("keeps the last 100 References, in order, and the In-Reply-To", async () => {
    const { authorId } = await seedAccount();
    const refs = Array.from({ length: 150 }, (_, i) => `r${i}@example.com`);
    const raw = lines(
      ...headerBlock([
        `References: ${refs.map((id) => `<${id}>`).join(CRLF + " ")}`,
        "In-Reply-To: <r149@example.com>",
      ]),
      "",
      "Reply.",
    );
    const result = await importOne(
      authorId,
      importOf(await uploadRaw(authorId, raw)),
    );
    expect(result.notCreated).toBeNull();
    const res = (await jmapCall(authorId, [
      [
        "Email/get",
        {
          accountId: acct(authorId),
          ids: [result.created.m1.id],
          properties: ["references", "inReplyTo"],
        },
        "g",
      ],
    ])) as Responses;
    expect(res[0][1].list[0].references).toEqual(refs.slice(-100));
    expect(res[0][1].list[0].inReplyTo).toEqual(["r149@example.com"]);
  });

  // RFC 2045 allows one Content-Type per entity. The raw scanner takes the
  // first and postal-mime the last, so a message with two must not come out
  // as a draft whose body silently disagrees with the message: refuse it, or
  // keep what the message shows.
  it("does not silently drop the body when a message repeats Content-Type", async () => {
    const { authorId } = await seedAccount();
    const html = await importOne(
      authorId,
      importOf(
        await uploadRaw(
          authorId,
          lines(
            ...headerBlock([
              "Content-Type: text/plain",
              "Content-Type: text/html",
            ]),
            "",
            "<p>Keep me</p>",
          ),
        ),
      ),
    );
    if (html.notCreated) {
      expect(html.notCreated.m1.type).toBe("invalidEmail");
    } else {
      const email = await getEmail(authorId, html.created.m1.id);
      expect(`${textOf(email) ?? ""}${htmlOf(email) ?? ""}`).toContain(
        "Keep me",
      );
    }
  });

  it("refuses a signed message whose multipart/signed Content-Type follows another Content-Type", async () => {
    const { authorId } = await seedAccount();
    const signed = await importOne(
      authorId,
      importOf(
        await uploadRaw(
          authorId,
          lines(
            ...headerBlock([
              "Content-Type: text/plain",
              'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="s"',
            ]),
            "",
            "--s",
            "Content-Type: text/plain",
            "",
            "Signed text.",
            "--s",
            "Content-Type: application/pgp-signature",
            "",
            "-----BEGIN PGP SIGNATURE-----",
            "--s--",
          ),
        ),
      ),
    );
    expect(signed.created).toBeNull();
    expect(signed.notCreated.m1.type).toBe("invalidEmail");
  });

  it("keeps the first email of a two-email import when the second is refused", async () => {
    const { authorId } = await seedAccount();
    const good = await uploadRaw(
      authorId,
      lines(...headerBlock(), "", "Good."),
    );
    const signed = await uploadRaw(
      authorId,
      lines(
        ...headerBlock(['Content-Type: multipart/signed; boundary="s"']),
        "",
        "--s",
        "Content-Type: text/plain",
        "",
        "x",
        "--s--",
      ),
    );
    const res = (await jmapCall(authorId, [
      importCall(authorId, {
        m1: importOf(good),
        m2: importOf(signed),
        m3: importOf("Gmissing"),
      }),
    ])) as Responses;
    const result = res[0][1];
    expect(Object.keys(result.created)).toEqual(["m1"]);
    expect(result.notCreated.m2.type).toBe("invalidEmail");
    expect(result.notCreated.m3).toMatchObject({
      type: "invalidProperties",
      properties: ["blobId"],
    });
    const drafts = await getDb().select().from(jmapDrafts);
    expect(drafts).toHaveLength(1);
    expect(textOf(await getEmail(authorId, result.created.m1.id))).toBe(
      "Good.",
    );
  });

  describe("partial failures inside the create path", () => {
    async function callWith(
      userId: string,
      methodCalls: [string, Record<string, unknown>, string][],
      overrides: { env?: CloudflareBindings; db?: any },
    ) {
      const db = getDb();
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      const allowed = await resolveAllowedInboxes(db, user);
      return (await executeJmapCalls(
        overrides.db ?? db,
        allowed,
        user,
        [CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY],
        methodCalls,
        {
          env: overrides.env ?? env,
          createdIds: new Map(),
          sender: recordingSender(OK).sender,
        },
      )) as Responses;
    }

    const withAttachment = () =>
      lines(
        ...headerBlock(['Content-Type: multipart/mixed; boundary="m"']),
        "",
        "--m",
        "Content-Type: text/plain",
        "",
        "Body.",
        "--m",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="a.pdf"',
        "",
        "%PDF",
        "--m--",
      );

    it("an R2 write failure answers serverFail and leaves no draft, content row or object", async () => {
      const { authorId } = await seedAccount();
      const blobId = await uploadRaw(authorId, withAttachment());
      const before = await snapshot(authorId);
      const failingR2 = new Proxy(env.R2, {
        get(target, prop) {
          if (prop === "put") {
            return async (key: string, ...rest: unknown[]) => {
              if (key.startsWith("jmap-content/")) {
                throw new Error("injected R2 failure");
              }
              return (target.put as any)(key, ...rest);
            };
          }
          const value = (target as any)[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const failingEnv = new Proxy(env, {
        get(target, prop) {
          if (prop === "R2") return failingR2;
          return (target as any)[prop];
        },
      }) as CloudflareBindings;
      const res = await callWith(
        authorId,
        [importCall(authorId, { m1: importOf(blobId) })],
        { env: failingEnv },
      );
      expect(res[0][1].created).toBeNull();
      expect(res[0][1].notCreated.m1.type).toBe("serverFail");
      expect(await snapshot(authorId)).toEqual(before);
    });

    it("a failing draft insert answers serverFail and removes what it wrote before answering", async () => {
      const { authorId } = await seedAccount();
      const blobId = await uploadRaw(authorId, withAttachment());
      const before = await snapshot(authorId);
      const realDb = getDb();
      const failingDb = new Proxy(realDb, {
        get(target, prop, receiver) {
          if (prop === "insert") {
            return (table: unknown) => {
              if (table === jmapDrafts) {
                throw new Error("injected draft insert failure");
              }
              return target.insert(table as any);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const res = await callWith(
        authorId,
        [importCall(authorId, { m1: importOf(blobId) })],
        { db: failingDb },
      );
      expect(res[0][1].created).toBeNull();
      expect(res[0][1].notCreated.m1.type).toBe("serverFail");
      // No content GC run: the failed create cleans up after itself.
      expect(await snapshot(authorId)).toEqual(before);
    });
  });

  describe("the internal blob map", () => {
    it("is not reachable from Email/set: an import's synthetic part id is blobNotFound, even in the same request", async () => {
      const { authorId } = await seedAccount();
      const blobId = await uploadRaw(
        authorId,
        lines(
          ...headerBlock(['Content-Type: multipart/mixed; boundary="m"']),
          "",
          "--m",
          "Content-Type: text/plain",
          "",
          "Body.",
          "--m",
          "Content-Type: application/pdf",
          'Content-Disposition: attachment; filename="secret.pdf"',
          "",
          "SECRET",
          "--m--",
        ),
      );
      const create = (id: string) =>
        draftCreate({
          attachments: [
            { blobId: id, type: "application/pdf", name: "stolen.pdf" },
          ],
        });
      const res = (await jmapCall(authorId, [
        importCall(authorId, { m1: importOf(blobId) }),
        [
          "Email/set",
          {
            accountId: acct(authorId),
            create: {
              d0: create("import-part-0"),
              d1: create("import-part-1"),
            },
          },
          "s",
        ],
      ])) as Responses;
      expect(res[0][1].created.m1).toBeTruthy();
      expect(res[1][1].created).toBeNull();
      expect(res[1][1].notCreated.d0).toEqual({
        type: "blobNotFound",
        notFound: ["import-part-0"],
      });
      expect(res[1][1].notCreated.d1).toEqual({
        type: "blobNotFound",
        notFound: ["import-part-1"],
      });
    });

    it("keeps two concurrent imports' parts apart", async () => {
      const { authorId } = await seedAccount();
      const message = (label: string) =>
        lines(
          ...headerBlock(['Content-Type: multipart/mixed; boundary="m"']),
          "",
          "--m",
          "Content-Type: text/plain",
          "",
          `Body ${label}.`,
          "--m",
          "Content-Type: application/octet-stream",
          `Content-Disposition: attachment; filename="${label}.bin"`,
          "",
          `bytes of ${label}`.repeat(200),
          "--m--",
        );
      const [a, b] = await Promise.all([
        uploadRaw(authorId, message("alpha")),
        uploadRaw(authorId, message("beta")),
      ]);
      const [ra, rb] = await Promise.all([
        importOne(authorId, importOf(a)),
        importOne(authorId, importOf(b)),
      ]);
      for (const [result, label] of [
        [ra, "alpha"],
        [rb, "beta"],
      ] as const) {
        expect(result.notCreated).toBeNull();
        const email = await getEmail(authorId, result.created.m1.id);
        expect(textOf(email)).toBe(`Body ${label}.`);
        expect(email.attachments[0].name).toBe(`${label}.bin`);
        const bytes = await blobBytes(authorId, email.attachments[0].blobId);
        expect(new TextDecoder().decode(bytes!)).toBe(
          `bytes of ${label}`.repeat(200),
        );
      }
    });
  });

  it("sends an imported draft with its attachment and inline image: bytes, file names and content ids", async () => {
    const { authorId } = await seedAccount();
    const png = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    const pdf = Uint8Array.from({ length: 256 }, (_, i) => i);
    const raw = lines(
      ...headerBlock(['Content-Type: multipart/mixed; boundary="mix"']),
      "",
      "--mix",
      'Content-Type: multipart/related; boundary="rel"',
      "",
      "--rel",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Logo <img src="cid:logo@x"></p>',
      "--rel",
      "Content-Type: image/png",
      "Content-ID: <logo@x>",
      "Content-Transfer-Encoding: base64",
      "",
      b64(png),
      "--rel--",
      "--mix",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      b64(pdf),
      "--mix--",
      "",
    );
    const blobId = await uploadRaw(authorId, raw);
    const { sender, calls } = recordingSender(OK);
    const res = (await jmapCall(
      authorId,
      [
        importCall(authorId, { m1: importOf(blobId) }),
        [
          "EmailSubmission/set",
          {
            accountId: acct(authorId),
            create: { k1: { identityId: idn(INBOX), emailId: "#m1" } },
          },
          "s",
        ],
      ],
      { sender },
    )) as Responses;
    expect(res[0][1].notCreated).toBeNull();
    expect(res[1][1].notCreated).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].html).toContain('src="cid:logo@x"');
    const sent = calls[0].attachments ?? [];
    const image = sent.find((part) => part.contentType === "image/png");
    const doc = sent.find((part) => part.contentType === "application/pdf");
    expect(image).toMatchObject({ contentId: "logo@x", disposition: "inline" });
    expect(new Uint8Array(image!.content as ArrayBuffer)).toEqual(png);
    expect(doc?.filename).toBe("résumé.pdf");
    expect(doc?.contentId ?? null).toBeNull();
    expect(new Uint8Array(doc!.content as ArrayBuffer)).toEqual(pdf);
  });

  it("lists an imported draft in the web as a read-only mail-client draft whose preview carries the HTML for the web to sanitise", async () => {
    const { authorId, authorApiKey } = await seedAccount();
    const html =
      '<p>Hi</p><script>alert(1)</script><img src=x onerror="alert(2)">';
    const raw = lines(
      ...headerBlock(["Content-Type: text/html; charset=utf-8"]),
      "",
      html,
    );
    const result = await importOne(
      authorId,
      importOf(await uploadRaw(authorId, raw)),
    );
    expect(result.notCreated).toBeNull();

    const list = (await (
      await authFetch(`/api/drafts/list?includeMailClient=1`, {
        apiKey: authorApiKey,
      })
    ).json()) as { drafts: { contextKey: string; subject: string }[] };
    const listed = list.drafts.filter((d) => d.contextKey.startsWith("jmap:"));
    expect(listed).toHaveLength(1);
    expect(listed[0].subject).toBe("Edge case");

    const preview = await authFetch(
      `/api/drafts/jmap-preview?contextKey=${encodeURIComponent(listed[0].contextKey)}`,
      { apiKey: authorApiKey },
    );
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { draft: { html: string | null } };
    // The server returns the draft's HTML as stored; JmapDraftPreview runs it
    // through sanitizeEmailHtml (covered by MailPage.test.tsx).
    expect(body.draft.html).toBe(html);

    const save = await authFetch("/api/drafts", {
      apiKey: authorApiKey,
      method: "PUT",
      body: JSON.stringify({
        contextKey: listed[0].contextKey,
        subject: "edited",
      }),
    });
    expect(save.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The on-success remap in less common shapes
// ---------------------------------------------------------------------------

describe("Email/import with the on-success remap", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  const plain = (from = INBOX) =>
    lines(
      `From: ${from}`,
      "To: alice@example.com",
      "Subject: Remap",
      `Message-ID: <remap-${Math.random().toString(36).slice(2)}@saasmail.test>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Remap body.",
      "",
    );

  function submit(
    userId: string,
    patch: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
    envelope?: Record<string, unknown>,
  ): [string, Record<string, unknown>, string] {
    return [
      "EmailSubmission/set",
      {
        accountId: acct(userId),
        create: {
          sub: {
            identityId: idn(INBOX),
            emailId: "#aerc",
            ...(envelope ? { envelope } : {}),
          },
        },
        ...(patch ? { onSuccessUpdateEmail: { "#sub": patch } } : {}),
        ...extra,
      },
      "1",
    ];
  }

  it("aerc with Drafts naming the other inbox and Sent naming the own one files into the own Sent", async () => {
    const { authorId } = await seedAccount();
    await addOtherInbox();
    const blobId = await uploadRaw(authorId, plain());
    const res = (await jmapCall(
      authorId,
      [
        importCall(authorId, {
          aerc: importOf(blobId, {
            mailboxIds: { [sys(OTHER, "drafts")]: true },
          }),
        }),
        submit(authorId, {
          "keywords/$draft": null,
          [`mailboxIds/${sys(INBOX, "sent")}`]: true,
          [`mailboxIds/${sys(OTHER, "drafts")}`]: null,
        }),
      ],
      { sender: recordingSender(OK).sender },
    )) as Responses;
    const emailId = res[0][1].created.aerc.id;
    expect(res[2][1].updated).toEqual({ [emailId]: null });
    const email = await getEmail(authorId, emailId);
    expect(email.mailboxIds).toEqual({ [sys(INBOX, "sent")]: true });
    expect(email.keywords.$draft).toBeUndefined();
  });

  it("leaves a patch naming an inbox the caller can't access as sent, and the implicit Email/set rejects it", async () => {
    const { memberId } = await seedAccount();
    // OTHER exists but the member has no permission on it.
    await addOtherInbox();
    const blobId = await uploadRaw(memberId, plain());
    const patch = {
      "keywords/$draft": null,
      [`mailboxIds/${sys(OTHER, "sent")}`]: true,
      [`mailboxIds/${sys(INBOX, "drafts")}`]: null,
    };
    const res = (await jmapCall(
      memberId,
      [
        importCall(memberId, { aerc: importOf(blobId) }),
        submit(memberId, patch),
      ],
      { sender: recordingSender(OK).sender },
    )) as Responses;
    const emailId = res[0][1].created.aerc.id;
    expect(res[1][1].notCreated).toBeNull();
    const [row] = await getDb().select().from(jmapSubmissions);
    expect(JSON.parse(row.onSuccessPatchJson!)).toEqual(patch);
    expect(res[2][1].updated).toBeNull();
    expect(res[2][1].notUpdated[emailId].type).toBe("invalidProperties");
  });

  it("with onSuccessDestroyEmail too, destroy wins and the remapped patch does not fail the call", async () => {
    const { authorId } = await seedAccount();
    await addOtherInbox();
    const blobId = await uploadRaw(authorId, plain());
    const res = (await jmapCall(
      authorId,
      [
        importCall(authorId, {
          aerc: importOf(blobId, {
            mailboxIds: { [sys(OTHER, "drafts")]: true },
          }),
        }),
        submit(
          authorId,
          {
            "keywords/$draft": null,
            [`mailboxIds/${sys(OTHER, "sent")}`]: true,
            [`mailboxIds/${sys(OTHER, "drafts")}`]: null,
          },
          { onSuccessDestroyEmail: ["#sub"] },
        ),
      ],
      { sender: recordingSender(OK).sender },
    )) as Responses;
    const emailId = res[0][1].created.aerc.id;
    expect(res[1][1].notCreated).toBeNull();
    expect(res[2][0]).toBe("Email/set");
    expect(res[2][1].destroyed).toEqual([emailId]);
    expect(res[2][1].notDestroyed ?? null).toBeNull();
    const [row] = await getDb().select().from(jmapSubmissions);
    expect(row.onSuccessMode).toBe("both");
    expect(JSON.parse(row.onSuccessPatchJson!)).toEqual({
      "keywords/$draft": null,
      [`mailboxIds/${sys(INBOX, "sent")}`]: true,
      [`mailboxIds/${sys(INBOX, "drafts")}`]: null,
    });
  });

  it("a delayed send with the remap, canceled from the web, goes back to the From inbox's Drafts", async () => {
    const { authorId, authorApiKey } = await seedAccount();
    await addOtherInbox();
    const blobId = await uploadRaw(authorId, plain());
    const { sender, calls } = recordingSender(OK);
    const res = (await jmapCall(
      authorId,
      [
        importCall(authorId, {
          aerc: importOf(blobId, {
            mailboxIds: { [sys(OTHER, "drafts")]: true },
          }),
        }),
        submit(
          authorId,
          {
            "keywords/$draft": null,
            [`mailboxIds/${sys(OTHER, "sent")}`]: true,
            [`mailboxIds/${sys(OTHER, "drafts")}`]: null,
          },
          {},
          {
            mailFrom: { email: INBOX, parameters: { HOLDFOR: "600" } },
            rcptTo: [{ email: "alice@example.com" }],
          },
        ),
      ],
      { sender },
    )) as Responses;
    const emailId = res[0][1].created.aerc.id;
    expect(res[1][1].created.sub.undoStatus).toBe("pending");
    expect(res[2][1].updated).toEqual({ [emailId]: null });
    expect((await getEmail(authorId, emailId)).mailboxIds).toEqual({
      [sys(INBOX, "sent")]: true,
    });
    expect(calls).toHaveLength(0);

    const internalId = parseSubmissionId(res[1][1].created.sub.id)!;
    const canceled = await authFetch(
      `/api/outbox/scheduled/${internalId}/cancel`,
      { apiKey: authorApiKey, method: "POST" },
    );
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toMatchObject({
      canceled: true,
      movedToDrafts: true,
    });
    const email = await getEmail(authorId, emailId);
    expect(email.mailboxIds).toEqual({ [sys(INBOX, "drafts")]: true });
    expect(email.keywords.$draft).toBe(true);
  });
});
