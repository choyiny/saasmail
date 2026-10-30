// Email/import reads the MIME tree with its own scanner and hands each leaf
// to postal-mime for charset decoding and file names. The two must read every
// leaf the same way, or a part the scanner calls text/plain can be parsed by
// postal-mime as multipart/signed and its signed text stored as the draft.
// Also here: the strict Content-Type grammar against what aerc (go-message)
// really writes, RFC 2046 boundary characters, a fold inside a quoted
// boundary, and the lazy split on multipart/mixed.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { jmapBlobs } from "../db/jmap-blobs.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import {
  MAX_IMPORT_PARTS,
  mimeSplitCounter,
  scanMimeStructure,
} from "../jmap/email-import";
import { storeUpload } from "../jmap/upload";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { acct, sys } from "./jmap-ids";
import { INBOX, jmapCall, seedAccount } from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

const CRLF = "\r\n";

function lines(...parts: string[]): string {
  return parts.join(CRLF);
}

function headers(): string[] {
  return [
    `From: Hello Team <${INBOX}>`,
    "To: Alice Example <alice@example.com>",
    "Subject: Agreement check",
    "Date: Tue, 29 Sep 2026 10:00:00 +0000",
    "Message-ID: <agreement-1@saasmail.test>",
    "MIME-Version: 1.0",
  ];
}

/** A multipart/signed body under boundary "zz": a text part and its signature. */
const SIGNED_BODY = [
  "",
  "--zz",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "SIGNED TEXT",
  "--zz",
  "Content-Type: application/pgp-signature",
  "",
  "-----BEGIN PGP SIGNATURE-----",
  "iQEzBAEBCAAdFiEE",
  "-----END PGP SIGNATURE-----",
  "--zz--",
];

async function uploadRaw(userId: string, raw: string) {
  const result = await storeUpload(getDb(), env, {
    userId,
    accountId: acct(userId),
    contentType: "message/rfc822",
    declaredLength: new TextEncoder().encode(raw).byteLength,
    body: new Response(raw).body,
    maxBytes: 50 * 1024 * 1024,
  });
  return result.blob!.blobId;
}

async function importRaw(userId: string, raw: string) {
  return importBlob(userId, await uploadRaw(userId, raw));
}

async function importBlob(userId: string, blobId: string) {
  const [response] = (await jmapCall(userId, [
    [
      "Email/import",
      {
        accountId: acct(userId),
        emails: {
          m1: {
            blobId,
            mailboxIds: { [sys(INBOX, "drafts")]: true },
            keywords: { $draft: true, $seen: true },
          },
        },
      },
      "i",
    ],
  ])) as Responses;
  expect(response[0]).toBe("Email/import");
  return response[1];
}

async function stored() {
  const db = getDb();
  return {
    drafts: (await db.select().from(jmapDrafts)).length,
    content: (await db.select().from(jmapMessageContent)).length,
    blobs: (await db.select({ id: jmapBlobs.id }).from(jmapBlobs)).length,
  };
}

async function getEmail(userId: string, id: string) {
  const [[, result]] = (await jmapCall(userId, [
    [
      "Email/get",
      {
        accountId: acct(userId),
        ids: [id],
        properties: ["id", "attachments", "textBody", "bodyValues"],
        bodyProperties: ["partId", "type", "name", "disposition"],
        fetchAllBodyValues: true,
      },
      "g",
    ],
  ])) as Responses;
  return result.list[0];
}

beforeAll(async () => {
  await applyMigrations();
});
beforeEach(async () => {
  await cleanDb();
});

describe("Email/import: the scanner and postal-mime read each leaf's headers alike", () => {
  // postal-mime decodes header lines as UTF-8 and collapses every \s
  // (U+00A0 included) before splitting the name off; the scanner reads bytes
  // and trims only ASCII whitespace from the name, so "Content-Type<NBSP>" is
  // Content-Type to postal-mime and an unknown header to the scanner.
  const nbspName = [
    'Content-Type : multipart/signed; protocol="application/pgp-signature"; boundary=zz',
  ];
  // postal-mime joins a continuation line onto any header line, even one
  // without a colon; the scanner drops a colon-less line, so the name and
  // value folded apart are Content-Type only to postal-mime.
  const foldedName = [
    "Content-Type",
    '\t: multipart/signed; protocol="application/pgp-signature"; boundary=zz',
  ];

  it("refuses a signed part hidden behind a delimiter line ending CR CR LF", async () => {
    const { authorId } = await seedAccount();
    // postal-mime reads `--m\r\r\n` as a delimiter; a line-based scan
    // doesn't. Any CR outside a CRLF is refused before either reads it.
    const raw =
      lines(
        ...headers(),
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "",
      ) +
      "--m\r\r\n" +
      lines(
        'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary=zz',
        ...SIGNED_BODY,
        "--m--",
        "",
      );
    const blobId = await uploadRaw(authorId, raw);
    const before = await stored();
    const result = await importBlob(authorId, blobId);
    expect(result.created).toBeNull();
    expect(result.notCreated?.m1?.type).toBe("invalidEmail");
    expect(await stored()).toEqual(before);
    expect(
      scanMimeStructure(new TextEncoder().encode("A: b\rc\r\n\r\nx")).error,
    ).toMatch(/CR/);
  });

  it.each([
    ["a Content-Type name ending in a UTF-8 no-break space", nbspName],
    ["a Content-Type name folded before its colon", foldedName],
  ])(
    "refuses a signed message behind %s (top level)",
    async (_label, contentType) => {
      const { authorId } = await seedAccount();
      const blobId = await uploadRaw(
        authorId,
        lines(...headers(), ...contentType, ...SIGNED_BODY, ""),
      );
      const before = await stored();
      const result = await importBlob(authorId, blobId);
      // Whatever the reason given, nothing signed may become a draft.
      expect(result.created).toBeNull();
      expect(result.notCreated?.m1?.type).toBe("invalidEmail");
      expect(await stored()).toEqual(before);
    },
  );

  it.each([
    ["a Content-Type name ending in a UTF-8 no-break space", nbspName],
    ["a Content-Type name folded before its colon", foldedName],
  ])(
    "refuses a signed message behind %s (a part of multipart/mixed)",
    async (_label, contentType) => {
      const { authorId } = await seedAccount();
      const blobId = await uploadRaw(
        authorId,
        lines(
          ...headers(),
          'Content-Type: multipart/mixed; boundary="m"',
          "",
          "--m",
          ...contentType,
          ...SIGNED_BODY,
          "--m--",
          "",
        ),
      );
      const before = await stored();
      const result = await importBlob(authorId, blobId);
      expect(result.created).toBeNull();
      expect(result.notCreated?.m1?.type).toBe("invalidEmail");
      expect(await stored()).toEqual(before);
    },
  );
});

describe("Email/import: what real clients write still imports", () => {
  /**
   * aerc 0.22.0 (go-message) `:postpone` output, byte for byte, for an
   * attachment whose long file name mixes French and Kabiyè: go-message
   * writes a non-ASCII parameter as RFC 2047 words inside one quoted string
   * (not RFC 2231 `filename*` or `filename*0*` sections), folded only after
   * the ";". Captured by driving the installed aerc against a maildir.
   */
  const AERC_NAME =
    "Rapport_trimestriel_été_2026_données_financières_très_détaillées_version_définitive_révisée_kpɛlɛŋ_ɖɔɔ_tɔm_Ŋʋ.pdf";
  const AERC_WORDS =
    '"=?utf-8?q?Rapport=5Ftrimestriel=5F=C3=A9t=C3=A9=5F2026=5Fdonn=C3=A9es=5Ff?= =?utf-8?q?inanci=C3=A8res=5Ftr=C3=A8s=5Fd=C3=A9taill=C3=A9es=5Fversion=5F?= =?utf-8?q?d=C3=A9finitive=5Fr=C3=A9vis=C3=A9e=5Fkp=C9=9Bl=C9=9B=C5=8B=5F?= =?utf-8?q?=C9=96=C9=94=C9=94=5Ft=C9=94m=5F=C5=8A=CA=8B.pdf?="';
  const AERC_DRAFT = lines(
    "Content-Type: multipart/mixed;",
    " boundary=d8d373191b661f545dabf4a0b4936d16a490e2f9f8b0476f6c550f695e82",
    "Mime-Version: 1.0",
    "Date: Tue, 29 Sep 2026 09:41:51 +0000",
    `Message-Id: <DLRPA1SAOAS8.1V7YTF1YXY9E7@saasmail.test>`,
    "Subject: Rapport",
    `From: "Hello Team" <${INBOX}>`,
    "To: <alice@example.com>",
    "X-Mailer: aerc 0.22.0",
    "",
    "--d8d373191b661f545dabf4a0b4936d16a490e2f9f8b0476f6c550f695e82",
    "Content-Type: multipart/alternative;",
    " boundary=6adca37d28ad6219988f8f36a9a17e6e7db240027c5f3a2d3ec82f8df179",
    "",
    "--6adca37d28ad6219988f8f36a9a17e6e7db240027c5f3a2d3ec82f8df179",
    "Content-Transfer-Encoding: quoted-printable",
    "Content-Disposition: inline",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "",
    "Body from aerc.",
    "",
    "--6adca37d28ad6219988f8f36a9a17e6e7db240027c5f3a2d3ec82f8df179--",
    "",
    "--d8d373191b661f545dabf4a0b4936d16a490e2f9f8b0476f6c550f695e82",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment;",
    ` filename=${AERC_WORDS}`,
    "Content-Type: application/pdf;",
    ` name=${AERC_WORDS}`,
    "",
    "JVBERi0xLjQgdGVzdAo=",
    "--d8d373191b661f545dabf4a0b4936d16a490e2f9f8b0476f6c550f695e82--",
    "",
  );

  it("imports aerc's own draft with a long French and Kabiyè attachment name, name decoded", async () => {
    const { authorId } = await seedAccount();
    const result = await importRaw(authorId, AERC_DRAFT);
    expect(result.notCreated).toBeNull();
    const email = await getEmail(authorId, result.created.m1.id);
    expect(email.attachments).toMatchObject([
      { type: "application/pdf", name: AERC_NAME, disposition: "attachment" },
    ]);
    expect(email.textBody).toHaveLength(1);
    expect(email.bodyValues[email.textBody[0].partId].value.trim()).toBe(
      "Body from aerc.",
    );
  });

  it("imports a quoted boundary made of RFC 2046 characters that are not RFC 2045 token characters", async () => {
    const { authorId } = await seedAccount();
    // bchars: ' ( ) + _ , - . / : = ? and space (not last).
    const boundary = "'()+_,-./:=? x";
    const result = await importRaw(
      authorId,
      lines(
        ...headers(),
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Inside odd boundary.",
        `--${boundary}--`,
        "",
      ),
    );
    expect(result.notCreated).toBeNull();
    const email = await getEmail(authorId, result.created.m1.id);
    expect(email.textBody).toHaveLength(1);
    expect(email.bodyValues[email.textBody[0].partId].value).toBe(
      "Inside odd boundary.",
    );
  });

  it("refuses the same boundary unquoted, where it is not a token", async () => {
    const { authorId } = await seedAccount();
    const blobId = await uploadRaw(
      authorId,
      lines(
        ...headers(),
        "Content-Type: multipart/mixed; boundary=a:b=c",
        "",
        "--a:b=c",
        "Content-Type: text/plain",
        "",
        "x",
        "--a:b=c--",
        "",
      ),
    );
    const before = await stored();
    const result = await importBlob(authorId, blobId);
    expect(result.created).toBeNull();
    expect(result.notCreated.m1.type).toBe("invalidEmail");
    expect(result.notCreated.m1.description).toContain("Content-Type");
    expect(await stored()).toEqual(before);
  });

  it("imports a boundary folded inside its quoted string, split on the unfolded value", async () => {
    const { authorId } = await seedAccount();
    const result = await importRaw(
      authorId,
      lines(
        ...headers(),
        'Content-Type: multipart/mixed; boundary="folded',
        ' boundary"',
        "",
        "--folded boundary",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Folded boundary body.",
        "--folded boundary--",
        "",
      ),
    );
    expect(result.notCreated).toBeNull();
    const email = await getEmail(authorId, result.created.m1.id);
    expect(email.textBody).toHaveLength(1);
    expect(email.bodyValues[email.textBody[0].partId].value).toBe(
      "Folded boundary body.",
    );
  });
});

describe("Email/import: the lazy split stops at the part limit for multipart/mixed too", () => {
  it("a multipart/mixed of 20,000 attachment parts is refused having split at most 101", () => {
    const raw = lines(
      ...headers(),
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b\r\nContent-Type: a/b\r\n\r\n".repeat(20_000) + "--b--",
      "",
    );
    mimeSplitCounter.ranges = 0;
    const scan = scanMimeStructure(new TextEncoder().encode(raw));
    expect(scan.error).toBe(
      `The message has more than ${MAX_IMPORT_PARTS} MIME parts`,
    );
    expect(mimeSplitCounter.ranges).toBeGreaterThan(0);
    expect(mimeSplitCounter.ranges).toBeLessThanOrEqual(MAX_IMPORT_PARTS + 1);
  });

  it("nested multipart/mixed parts share one limit: 60 x 60 attachments split at most 101 ranges in all", () => {
    const inner = (index: number) =>
      [
        `--o`,
        `Content-Type: multipart/mixed; boundary=i${index}`,
        "",
        `--i${index}\r\nContent-Type: a/b\r\n\r\n`.repeat(60) + `--i${index}--`,
      ].join(CRLF);
    const raw = lines(
      ...headers(),
      "Content-Type: multipart/mixed; boundary=o",
      "",
      Array.from({ length: 60 }, (_, index) => inner(index)).join(CRLF),
      "--o--",
      "",
    );
    mimeSplitCounter.ranges = 0;
    const scan = scanMimeStructure(new TextEncoder().encode(raw));
    expect(scan.error).toBe(
      `The message has more than ${MAX_IMPORT_PARTS} MIME parts`,
    );
    expect(mimeSplitCounter.ranges).toBeLessThanOrEqual(MAX_IMPORT_PARTS + 1);
  });

  it("a preamble and an epilogue holding delimiter-like lines stay outside the parts", () => {
    const raw = lines(
      ...headers(),
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "This is the preamble.",
      "--bx is not a delimiter",
      "--b",
      "Content-Type: text/plain",
      "",
      "Only part.",
      "--b--",
      "Epilogue.",
      "--b",
      "Content-Type: application/x-after-close",
      "",
      "never a part",
      "",
    );
    const bytes = new TextEncoder().encode(raw);
    const scan = scanMimeStructure(bytes);
    expect(scan.error).toBeNull();
    expect(scan.attachmentLeaves).toEqual([]);
    const leaf = scan.textLeaf!;
    expect(
      new TextDecoder().decode(bytes.subarray(leaf.bodyStart, leaf.end)),
    ).toBe("Only part.");
  });
});
