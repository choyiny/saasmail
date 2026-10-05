// Email/import's raw MIME scanner accepts one strict grammar for every
// Content-Type and Content-Disposition header at any depth, and refuses
// anything else with invalidEmail and nothing stored. The multipart splitter
// is lazy, so a message with far more parts than the limit costs bounded work.
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

type MethodCall = [string, Record<string, unknown>, string];
type Responses = [string, Record<string, any>, string][];

const CRLF = "\r\n";

function lines(...parts: string[]): string {
  return parts.join(CRLF);
}

function headers(): string[] {
  return [
    `From: Hello Team <${INBOX}>`,
    "To: Alice Example <alice@example.com>",
    "Subject: Grammar check",
    "Date: Tue, 29 Sep 2026 10:00:00 +0000",
    "Message-ID: <grammar-1@saasmail.test>",
    "MIME-Version: 1.0",
  ];
}

/** A single-part message: the given headers are the message's own. */
function topLevel(partHeaders: string[], body: string[] = ["Body."]) {
  return lines(...headers(), ...partHeaders, "", ...body, "");
}

/**
 * multipart/mixed -> multipart/alternative -> the part, so the bad header is
 * two levels down: the scanner must apply the same grammar at every depth.
 */
function twoLevelsDown(partHeaders: string[], body: string[] = ["Body."]) {
  return lines(
    ...headers(),
    'Content-Type: multipart/mixed; boundary="m"',
    "",
    "--m",
    'Content-Type: multipart/alternative; boundary="a"',
    "",
    "--a",
    ...partHeaders,
    "",
    ...body,
    "--a--",
    "--m--",
    "",
  );
}

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

function importCall(
  userId: string,
  emails: Record<string, unknown>,
): MethodCall {
  return ["Email/import", { accountId: acct(userId), emails }, "i"];
}

function importOf(blobId: string): Record<string, unknown> {
  return {
    blobId,
    mailboxIds: { [sys(INBOX, "drafts")]: true },
    keywords: { $draft: true, $seen: true },
  };
}

async function importOne(userId: string, item: Record<string, unknown>) {
  const res = (await jmapCall(userId, [
    importCall(userId, { m1: item }),
  ])) as Responses;
  return res[0];
}

async function r2Keys(prefix: string): Promise<string[]> {
  const listed = await env.R2.list({ prefix });
  return listed.objects.map((object) => object.key).sort();
}

/** What "nothing was written" means for one import: no draft, content, blob or R2 object. */
async function snapshot(userId: string) {
  const db = getDb();
  return {
    drafts: (await db.select().from(jmapDrafts)).length,
    content: (await db.select().from(jmapMessageContent)).length,
    blobs: (await db.select({ id: jmapBlobs.id }).from(jmapBlobs))
      .map((row) => row.id)
      .sort(),
    objects: await r2Keys(`jmap-content/${userId}/`),
  };
}

async function expectRefusal(
  userId: string,
  item: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  const before = await snapshot(userId);
  const [name, result] = await importOne(userId, item);
  expect(name).toBe("Email/import");
  expect(result.created).toBeNull();
  expect(result.notCreated.m1).toMatchObject(expected);
  expect(await snapshot(userId)).toEqual(before);
  expect(before.drafts).toBe(0);
  expect(before.content).toBe(0);
  return result.notCreated.m1;
}

async function expectImported(userId: string, raw: string) {
  const blobId = await uploadRaw(userId, raw);
  const [name, result] = await importOne(userId, importOf(blobId));
  expect(name).toBe("Email/import");
  expect(result.notCreated).toBeNull();
  expect(result.created.m1.id).toMatch(/^D/);
  return result.created.m1;
}

async function getEmail(userId: string, id: string) {
  const res = (await jmapCall(userId, [
    [
      "Email/get",
      {
        accountId: acct(userId),
        ids: [id],
        properties: ["id", "attachments", "textBody", "htmlBody", "bodyValues"],
        bodyProperties: ["partId", "type", "name", "disposition", "size"],
        fetchAllBodyValues: true,
      },
      "g",
    ],
  ])) as Responses;
  return res[0][1].list[0];
}

/**
 * Every refused Content-Type form: what it is called here, the phrase its
 * refusal has to name, and the header line itself. A header that is malformed
 * for some *other* reason than the case claims is still refused, so naming the
 * header alone would let a mistyped case pass without testing its class.
 */
const BAD_CONTENT_TYPE: [string, string, string][] = [
  [
    "a parameter without =",
    "without a value",
    "Content-Type: text/plain; charset=utf-8; rogue",
  ],
  [
    "a parameter with no value",
    "no value for",
    "Content-Type: text/plain; charset=",
  ],
  [
    "an unterminated quoted value",
    "unterminated",
    'Content-Type: text/plain; charset="utf-8',
  ],
  [
    "junk after a closing quote",
    "after the value of",
    'Content-Type: text/plain; charset="utf-8"x',
  ],
  [
    "a repeated attribute in a different case",
    "repeats its charset",
    "Content-Type: text/plain; charset=utf-8; CHARSET=iso-8859-1",
  ],
  [
    "one name given plainly and in its RFC 2231 form",
    "repeats its name",
    "Content-Type: text/plain; name*=utf-8''x; name=y",
  ],
  [
    "an attribute alongside an RFC 2231 form that is not the one allowed",
    "RFC 2231",
    "Content-Type: text/plain; charset=utf-8; charset*=utf-8''x",
  ],
  [
    "an RFC 2231 charset*",
    "RFC 2231",
    "Content-Type: text/plain; charset*=utf-8''x",
  ],
  [
    "an RFC 2231 boundary*0",
    "RFC 2231",
    "Content-Type: text/plain; boundary*0=a",
  ],
  ["an RFC 2231 name*0", "RFC 2231", "Content-Type: text/plain; name*0=a"],
  [
    "a type that is not a token",
    "other than a parameter",
    "Content-Type: text/pl@in",
  ],
  ["a type with no subtype", "no type/subtype", "Content-Type: text"],
  [
    "whitespace inside the type",
    "no type/subtype",
    "Content-Type: te xt/plain",
  ],
];

/** The same grammar on Content-Disposition, with the part's type kept valid. */
const BAD_DISPOSITION: [string, string, string][] = [
  [
    "a parameter without =",
    "without a value",
    "Content-Disposition: attachment; rogue",
  ],
  [
    "a parameter with no value",
    "no value for",
    "Content-Disposition: attachment; filename=",
  ],
  [
    "an unterminated quoted value",
    "unterminated",
    'Content-Disposition: attachment; filename="a.bin',
  ],
  [
    "junk after a closing quote",
    "after the value of",
    'Content-Disposition: attachment; filename="a.bin"x',
  ],
  [
    "a repeated filename in a different case",
    "repeats its filename",
    'Content-Disposition: attachment; filename="a.bin"; FILENAME="b.bin"',
  ],
  [
    "one filename given plainly and in its RFC 2231 form",
    "repeats its filename",
    "Content-Disposition: attachment; filename*=utf-8''a.bin; filename=b.bin",
  ],
  [
    "an RFC 2231 filename*0",
    "RFC 2231",
    "Content-Disposition: attachment; filename*0=a",
  ],
  ["an RFC 2231 name*", "RFC 2231", "Content-Disposition: attachment; name*=x"],
  [
    "a disposition type that is not a token",
    "other than a parameter",
    "Content-Disposition: attach ment",
  ],
];

const ATTACHMENT_TYPE = 'Content-Type: application/octet-stream; name="a.bin"';

beforeAll(async () => {
  await applyMigrations();
});
beforeEach(async () => {
  await cleanDb();
});

describe("Email/import: strict Content-Type grammar", () => {
  it("refuses a boundary*0 continuation section that hides a nested multipart/signed", async () => {
    const { authorId } = await seedAccount();
    const raw = lines(
      ...headers(),
      "Content-Type: multipart/mixed; boundary=seen; boundary*0=real; boundary*1=x",
      "",
      "--realx",
      'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="s"',
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
      "--realx--",
      "",
    );
    const error = await expectRefusal(
      authorId,
      importOf(await uploadRaw(authorId, raw)),
      { type: "invalidEmail" },
    );
    // Refused as a malformed Content-Type, before anything is stored: the
    // continuation section must never be read as "the real boundary".
    expect(error.description).toContain("Content-Type");
    expect(error.description).toContain("boundary");
  });

  it("refuses a parameter without = ahead of the real boundary", async () => {
    const { authorId } = await seedAccount();
    const raw = lines(
      ...headers(),
      "Content-Type: multipart/mixed; boundary=seen; rogue; boundary=real",
      "",
      "--real",
      'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="s"',
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
      "--real--",
      "",
    );
    const error = await expectRefusal(
      authorId,
      importOf(await uploadRaw(authorId, raw)),
      { type: "invalidEmail" },
    );
    expect(error.description).toContain("Content-Type");
    expect(error.description).toContain("rogue");
  });

  it.each([
    [
      "a boundary*0 continuation",
      "boundary=seen; boundary*0=real; boundary*1=x",
      "realx",
    ],
    [
      "a stray word between two boundaries",
      "boundary=seen; rogue; boundary=real",
      "real",
    ],
  ])(
    "refuses %s hiding a multipart/signed two levels down",
    async (_label, params, delimiter) => {
      const { authorId } = await seedAccount();
      const raw = lines(
        ...headers(),
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "--m",
        'Content-Type: multipart/alternative; boundary="a"',
        "",
        "--a",
        `Content-Type: multipart/mixed; ${params}`,
        "",
        `--${delimiter}`,
        'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="s"',
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
        `--${delimiter}--`,
        "--a--",
        "--m--",
        "",
      );
      const error = await expectRefusal(
        authorId,
        importOf(await uploadRaw(authorId, raw)),
        { type: "invalidEmail" },
      );
      expect(error.description).toContain("Content-Type");
      expect(error.description).not.toContain("Signed");
    },
  );

  it.each(BAD_CONTENT_TYPE)(
    "refuses %s in the message's own Content-Type (%s)",
    async (_label, reason, contentType) => {
      const { authorId } = await seedAccount();
      const error = await expectRefusal(
        authorId,
        importOf(await uploadRaw(authorId, topLevel([contentType]))),
        { type: "invalidEmail" },
      );
      // The refusal names the header, so it came from the grammar and not
      // from a later rule (a signed part, a second body, a size limit), and
      // names why, so this case still tests the violation its label claims.
      expect(error.description).toContain("Content-Type");
      expect(error.description).toContain(reason);
    },
  );

  it.each(BAD_CONTENT_TYPE)(
    "refuses %s in a Content-Type two levels down (%s)",
    async (_label, reason, contentType) => {
      const { authorId } = await seedAccount();
      const error = await expectRefusal(
        authorId,
        importOf(await uploadRaw(authorId, twoLevelsDown([contentType]))),
        { type: "invalidEmail" },
      );
      expect(error.description).toContain("Content-Type");
      expect(error.description).toContain(reason);
    },
  );

  it.each(BAD_DISPOSITION)(
    "refuses %s in the message's own Content-Disposition (%s)",
    async (_label, reason, contentDisposition) => {
      const { authorId } = await seedAccount();
      const error = await expectRefusal(
        authorId,
        importOf(
          await uploadRaw(
            authorId,
            topLevel([ATTACHMENT_TYPE, contentDisposition]),
          ),
        ),
        { type: "invalidEmail" },
      );
      expect(error.description).toContain("Content-Disposition");
      expect(error.description).toContain(reason);
    },
  );

  it.each(BAD_DISPOSITION)(
    "refuses %s in a Content-Disposition two levels down (%s)",
    async (_label, reason, contentDisposition) => {
      const { authorId } = await seedAccount();
      const error = await expectRefusal(
        authorId,
        importOf(
          await uploadRaw(
            authorId,
            twoLevelsDown([ATTACHMENT_TYPE, contentDisposition]),
          ),
        ),
        { type: "invalidEmail" },
      );
      expect(error.description).toContain("Content-Disposition");
      expect(error.description).toContain(reason);
    },
  );

  // The controls below keep the two scaffolds honest: they import when the
  // part's own headers are well formed, so every refusal above is the one
  // header under test and not the envelope it was wrapped in.
  it("imports a well-formed part two levels down", async () => {
    const { authorId } = await seedAccount();
    const created = await expectImported(
      authorId,
      twoLevelsDown([
        "Content-Type: text/plain; charset=utf-8",
        "Content-Disposition: inline",
      ]),
    );
    const email = await getEmail(authorId, created.id);
    expect(email.textBody).toHaveLength(1);
    expect(email.bodyValues[email.textBody[0].partId].value.trim()).toBe(
      "Body.",
    );
    expect(email.attachments).toEqual([]);
  });

  it("imports a well-formed attachment with a plain disposition", async () => {
    const { authorId } = await seedAccount();
    const created = await expectImported(
      authorId,
      topLevel([ATTACHMENT_TYPE, "Content-Disposition: attachment"]),
    );
    const email = await getEmail(authorId, created.id);
    expect(email.attachments).toMatchObject([
      {
        type: "application/octet-stream",
        name: "a.bin",
        disposition: "attachment",
      },
    ]);
  });

  it("imports a Content-Type whose only name is RFC 2231 encoded", async () => {
    const { authorId } = await seedAccount();
    const created = await expectImported(
      authorId,
      topLevel(
        ["Content-Type: application/pdf; name*=utf-8''r%C3%A9sum%C3%A9.pdf"],
        ["%PDF-1.4 not really"],
      ),
    );
    const email = await getEmail(authorId, created.id);
    expect(email.attachments).toMatchObject([
      {
        type: "application/pdf",
        name: "résumé.pdf",
        disposition: "attachment",
      },
    ]);
  });

  it("imports a Content-Disposition whose only filename is RFC 2231 encoded", async () => {
    const { authorId } = await seedAccount();
    const created = await expectImported(
      authorId,
      topLevel(
        [
          "Content-Type: application/pdf",
          "Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf",
        ],
        ["%PDF-1.4 not really"],
      ),
    );
    const email = await getEmail(authorId, created.id);
    expect(email.attachments).toMatchObject([
      {
        type: "application/pdf",
        name: "résumé.pdf",
        disposition: "attachment",
      },
    ]);
  });

  it("imports a boundary whose quoted value uses a backslash escape", async () => {
    const { authorId } = await seedAccount();
    // "\=" decodes to "=", an RFC 2046 bchar; a decoded '"' is not one.
    const created = await expectImported(
      authorId,
      lines(
        ...headers(),
        'Content-Type: multipart/mixed; boundary="a\\=b"',
        "",
        "--a=b",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Escaped boundary.",
        "--a=b--",
        "",
      ),
    );
    const email = await getEmail(authorId, created.id);
    // The part is only found if the escape was decoded out of the boundary,
    // so assert the body exists before indexing it rather than crashing.
    expect(email.textBody).toHaveLength(1);
    expect(email.bodyValues[email.textBody[0].partId].value).toBe(
      "Escaped boundary.",
    );
  });

  it.each([
    ["a trailing semicolon", "Content-Type: text/plain; charset=utf-8;"],
    [
      "whitespace before a semicolon",
      "Content-Type: text/plain ; charset=utf-8",
    ],
    [
      "comments around the type and the parameter",
      "Content-Type: text/plain (c); charset=utf-8 (c)",
    ],
    [
      "an uppercase type and attribute",
      "Content-Type: TEXT/PLAIN; CHARSET=UTF-8",
    ],
  ])("imports a Content-Type with %s", async (_label, contentType) => {
    const { authorId } = await seedAccount();
    const created = await expectImported(authorId, topLevel([contentType]));
    const email = await getEmail(authorId, created.id);
    expect(email.textBody).toHaveLength(1);
    // A single-part message's body ends in the line break that ends the
    // message, so only the text itself is compared.
    expect(email.bodyValues[email.textBody[0].partId].value.trim()).toBe(
      "Body.",
    );
  });
});

describe("Email/import: lazy multipart split", () => {
  /**
   * 200,000 minimal parts ("--b" and an empty header block) in a
   * multipart/digest, where a part without a Content-Type is message/rfc822:
   * each is an attachment leaf, so no body rule fires first and the walk runs
   * into the part limit. About 1.4 MB, well under 5 MiB.
   */
  function manyMinimalParts() {
    return lines(
      ...headers(),
      "Content-Type: multipart/digest; boundary=b",
      "",
      "--b\r\n\r\n".repeat(200_000) + "--b--",
      "",
    );
  }

  it("refuses 200,000 minimal parts at the part limit, having split at most 101", () => {
    const bytes = new TextEncoder().encode(manyMinimalParts());
    expect(bytes.byteLength).toBeLessThan(5 * 1024 * 1024);

    mimeSplitCounter.ranges = 0;
    const scan = scanMimeStructure(bytes);
    expect(scan.error).toBe(
      `The message has more than ${MAX_IMPORT_PARTS} MIME parts`,
    );
    // An eager split would have built all 200,000 ranges first.
    expect(mimeSplitCounter.ranges).toBeGreaterThan(0);
    expect(mimeSplitCounter.ranges).toBeLessThanOrEqual(MAX_IMPORT_PARTS + 1);
  });

  it("refuses the same message through Email/import with invalidEmail, storing nothing", async () => {
    const { authorId } = await seedAccount();
    const blobId = await uploadRaw(authorId, manyMinimalParts());
    mimeSplitCounter.ranges = 0;
    const error = await expectRefusal(authorId, importOf(blobId), {
      type: "invalidEmail",
    });
    expect(error.description).toBe(
      `The message has more than ${MAX_IMPORT_PARTS} MIME parts`,
    );
    expect(mimeSplitCounter.ranges).toBeLessThanOrEqual(MAX_IMPORT_PARTS + 1);
  });
});

describe("Email/import: boundaries and 8-bit bytes in structural headers", () => {
  const NBSP = " ";

  /** A multipart/mixed under `boundaryParam` holding a multipart/signed. */
  function signedUnder(boundaryParam: string, delimiter: string): string[] {
    return [
      `Content-Type: multipart/mixed; boundary=${boundaryParam}`,
      "",
      `--${delimiter}`,
      'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="s"',
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
      `--${delimiter}--`,
    ];
  }

  it.each([
    ["top level", false],
    ["nested in a multipart/mixed", true],
  ])(
    "refuses a quoted boundary holding a no-break space (%s)",
    async (_label, nested) => {
      const { authorId } = await seedAccount();
      const inner = signedUnder(`"a${NBSP}b"`, `a${NBSP}b`);
      const raw = nested
        ? lines(
            ...headers(),
            'Content-Type: multipart/mixed; boundary="o"',
            "",
            "--o",
            ...inner,
            "--o--",
            "",
          )
        : lines(...headers(), ...inner, "");
      const error = await expectRefusal(
        authorId,
        importOf(await uploadRaw(authorId, raw)),
        { type: "invalidEmail" },
      );
      expect(error.description).toContain("boundary");
    },
  );

  it.each([
    ["71 characters", `"${"b".repeat(71)}"`],
    ["a double quote", '"a\\"b"'],
    ["a trailing space", '"ab "'],
    ["an empty value", '""'],
    ["a non-ASCII byte", `"a${NBSP}b"`],
  ])("refuses a boundary with %s", async (_label, boundaryParam) => {
    const { authorId } = await seedAccount();
    const raw = lines(
      ...headers(),
      `Content-Type: multipart/mixed; boundary=${boundaryParam}`,
      "",
      "--x",
      "Content-Type: text/plain",
      "",
      "Body.",
      "--x--",
      "",
    );
    const error = await expectRefusal(
      authorId,
      importOf(await uploadRaw(authorId, raw)),
      { type: "invalidEmail" },
    );
    expect(error.description).toContain("boundary");
  });

  it.each([
    ["a non-ASCII charset", `Content-Type: text/plain; charset="utf${NBSP}8"`],
    [
      "a non-ASCII byte in a comment",
      `Content-Type: text/plain (${NBSP}); charset=utf-8`,
    ],
    [
      "a non-ASCII Content-Transfer-Encoding",
      `Content-Transfer-Encoding: base64${NBSP}`,
    ],
  ])("refuses %s", async (_label, header) => {
    const { authorId } = await seedAccount();
    const error = await expectRefusal(
      authorId,
      importOf(await uploadRaw(authorId, topLevel([header]))),
      { type: "invalidEmail" },
    );
    expect(error.description).toMatch(/non-ASCII/);
  });

  it("still imports an 8-bit file name and an 8-bit Subject", async () => {
    const { authorId } = await seedAccount();
    const created = await expectImported(
      authorId,
      lines(
        `From: Hello Team <${INBOX}>`,
        "To: Alice Example <alice@example.com>",
        "Subject: Café résumé",
        "Date: Tue, 29 Sep 2026 10:00:00 +0000",
        "Message-ID: <grammar-8bit@saasmail.test>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "--m",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Body.",
        "--m",
        'Content-Type: application/pdf; name="résumé.pdf"',
        'Content-Disposition: attachment; filename="résumé.pdf"',
        "",
        "%PDF-1.4",
        "--m--",
        "",
      ),
    );
    const email = await getEmail(authorId, created.id);
    expect(email.attachments).toHaveLength(1);
  });
});
