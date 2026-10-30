import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { acct, idn, mbx, sys } from "./jmap-ids";
import { users } from "../db/auth.schema";
import { jmapBlobs } from "../db/jmap-blobs.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { readBlobBytes, resolveReadableBlob } from "../jmap/blobs";
import { MAX_OBJECTS_IN_SET } from "../jmap/constants";
import {
  decodeLeafBody,
  parseHeaderValue,
  parseMessageIdList,
  scanMimeStructure,
  stripComments,
  transferEncodingToken,
} from "../jmap/email-import";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { publicReceivedRawBlobId } from "../jmap/public-ids";
import { createTestEmail, createTestPerson } from "./helpers";
import { thread } from "./jmap-ids";
import { storeUpload } from "../jmap/upload";
import { listJmapOnlyDrafts } from "../jmap/web-drafts";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import {
  INBOX,
  OK,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

const OTHER = "privacy@saasmail.test";
const CRLF = "\r\n";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff,
  0x80, 0x00, 0x7f,
]);
/** Every byte value, so an encoding slip shows up as a byte difference. */
const PDF = Uint8Array.from({ length: 256 }, (_, i) => i);
const FORWARDED = [
  "From: Zed <zed@example.com>",
  "To: Hello Team <hello@saasmail.test>",
  "Subject: The original",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Forwarded body.",
  "",
].join(CRLF);

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (btoa(binary).match(/.{1,76}/g) ?? []).join(CRLF);
}

function lines(...parts: string[]): string {
  return parts.join(CRLF);
}

function headers(from = INBOX, extra: string[] = []): string[] {
  return [
    `From: Hello Team <${from}>`,
    "To: Alice Example <alice@example.com>",
    'Cc: "Bob, Jr." <bob@example.com>',
    "Bcc: Carol <carol@example.com>",
    "Subject: =?UTF-8?Q?Quarterly_n=C3=BCmbers?=",
    "Date: Tue, 29 Sep 2026 10:00:00 +0000",
    "Message-ID: <import-1@saasmail.test>",
    "In-Reply-To: <orig-1@example.com>",
    "References: <root-1@example.com> <orig-1@example.com>",
    "X-Mailer: aerc 0.20.1",
    "MIME-Version: 1.0",
    ...extra,
  ];
}

/** text + HTML, one attachment, one inline image, one attached message/rfc822. */
function fullMessage(from = INBOX): string {
  return lines(
    ...headers(from),
    'Content-Type: multipart/mixed; boundary="mix"',
    "",
    "--mix",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Hello Alice,",
    "see the attached numbers. Caf=C3=A9 =",
    "au lait.",
    "--alt",
    'Content-Type: multipart/related; boundary="rel"',
    "",
    "--rel",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Hello <b>Alice</b> <img src="cid:logo@import"></p>',
    "--rel",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <logo@import>",
    'Content-Disposition: inline; filename="logo.png"',
    "",
    b64(PNG),
    "--rel--",
    "--alt--",
    "--mix",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(PDF),
    "--mix",
    "Content-Type: message/rfc822",
    'Content-Disposition: attachment; filename="original.eml"',
    "",
    FORWARDED,
    "--mix--",
    "",
  );
}

/** aerc's plain message: one text/plain body, no multipart. */
function plainMessage(from = INBOX, to = "alice@example.com"): string {
  return lines(
    `From: ${from}`,
    `To: ${to}`,
    "Subject: From aerc",
    "Date: Tue, 29 Sep 2026 10:00:00 +0000",
    `Message-ID: <aerc-${Math.random().toString(36).slice(2)}@saasmail.test>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    "Sent from aerc.",
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

async function addOtherInbox() {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: OTHER,
    displayName: "Privacy",
    createdAt: now,
    updatedAt: now,
  });
}

function importCall(
  userId: string,
  emails: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): [string, Record<string, unknown>, string] {
  return ["Email/import", { accountId: acct(userId), emails, ...extra }, "i"];
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
  return res[0];
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
          "blobId",
          "mailboxIds",
          "keywords",
          "receivedAt",
          "from",
          "to",
          "cc",
          "bcc",
          "subject",
          "sentAt",
          "messageId",
          "inReplyTo",
          "references",
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
  options: { sender?: ReturnType<typeof recordingSender>["sender"] } = {},
) {
  const before = await snapshot(userId);
  const [name, result] = await importOne(userId, item, options);
  expect(name).toBe("Email/import");
  expect(result.created).toBeNull();
  expect(result.notCreated.m1).toMatchObject(expected);
  expect(await snapshot(userId)).toEqual(before);
  expect(before.drafts).toBe(0);
  expect(before.content).toBe(0);
  return result.notCreated.m1;
}

describe("Email/import", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("imports text, HTML, an attachment, an inline image and a message/rfc822 into a draft", async () => {
    const { authorId } = await seedAccount();
    const blobId = await uploadRaw(authorId, fullMessage());
    const [name, result] = await importOne(
      authorId,
      importOf(blobId, { receivedAt: "2026-09-20T08:30:00Z" }),
    );
    expect(name).toBe("Email/import");
    expect(result.notCreated).toBeNull();
    const created = result.created.m1;
    expect(Object.keys(created).sort()).toEqual([
      "blobId",
      "id",
      "size",
      "threadId",
    ]);
    expect(created.id).toMatch(/^D/);
    // The blob is the rebuilt message, not the upload.
    expect(created.blobId).not.toBe(blobId);

    const email = await getEmail(authorId, created.id);
    expect(email.mailboxIds).toEqual({ [sys(INBOX, "drafts")]: true });
    expect(email.keywords).toEqual({ $draft: true, $seen: true });
    expect(email.receivedAt).toBe("2026-09-20T08:30:00Z");
    expect(email.from).toEqual([{ name: "Hello Team", email: INBOX }]);
    expect(email.to).toEqual([
      { name: "Alice Example", email: "alice@example.com" },
    ]);
    expect(email.cc).toEqual([{ name: "Bob, Jr.", email: "bob@example.com" }]);
    expect(email.bcc).toEqual([{ name: "Carol", email: "carol@example.com" }]);
    expect(email.subject).toBe("Quarterly nümbers");
    expect(email.sentAt).toBe("2026-09-29T10:00:00Z");
    expect(email.messageId).toEqual(["import-1@saasmail.test"]);
    expect(email.inReplyTo).toEqual(["orig-1@example.com"]);
    expect(email.references).toEqual([
      "root-1@example.com",
      "orig-1@example.com",
    ]);

    const text = email.bodyValues[email.textBody[0].partId].value;
    expect(text).toBe("Hello Alice,\nsee the attached numbers. Café au lait.");
    const html = email.bodyValues[email.htmlBody[0].partId].value;
    expect(html).toBe('<p>Hello <b>Alice</b> <img src="cid:logo@import"></p>');

    const inline = email.htmlBody.find(
      (part: { type: string }) => part.type === "image/png",
    );
    const attachments = email.attachments as {
      blobId: string;
      type: string;
      name: string | null;
      disposition: string | null;
      cid: string | null;
    }[];
    const byType = new Map(attachments.map((part) => [part.type, part]));
    const image = inline ?? byType.get("image/png");
    expect(image).toMatchObject({
      type: "image/png",
      name: "logo.png",
      disposition: "inline",
      cid: "logo@import",
    });
    expect(byType.get("application/pdf")).toMatchObject({
      name: "report.pdf",
      disposition: "attachment",
    });
    expect(byType.get("message/rfc822")).toMatchObject({
      name: "original.eml",
      disposition: "attachment",
    });
    expect(await blobBytes(authorId, image.blobId)).toEqual(PNG);
    expect(
      await blobBytes(authorId, byType.get("application/pdf")!.blobId),
    ).toEqual(PDF);
    expect(
      new TextDecoder().decode(
        (await blobBytes(authorId, byType.get("message/rfc822")!.blobId))!,
      ),
    ).toBe(FORWARDED);

    // Headers not listed in the spec are dropped from the rebuilt message.
    const rebuilt = new TextDecoder().decode(
      (await blobBytes(authorId, created.blobId))!,
    );
    expect(rebuilt).not.toContain("X-Mailer");
    expect(rebuilt).toContain("Message-ID: <import-1@saasmail.test>");

    // The web lists it as a mail-client draft.
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, authorId));
    const listed = await listJmapOnlyDrafts(
      db,
      await resolveAllowedInboxes(db, user),
      authorId,
      undefined,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      fromAddress: INBOX,
      subject: "Quarterly nümbers",
    });
  });

  it("imports an HTML-only message without inventing a text body", async () => {
    const { authorId } = await seedAccount();
    const raw = lines(
      `From: ${INBOX}`,
      "To: alice@example.com",
      "Subject: HTML only",
      "Content-Type: text/html; charset=iso-8859-1",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "<p>Caf=E9</p>",
      "",
    );
    const blobId = await uploadRaw(authorId, raw);
    const [, result] = await importOne(authorId, importOf(blobId));
    const email = await getEmail(authorId, result.created.m1.id);
    expect(email.htmlBody).toHaveLength(1);
    expect(email.htmlBody[0].type).toBe("text/html");
    expect(email.bodyValues[email.htmlBody[0].partId].value).toBe(
      "<p>Café</p>\n",
    );
    expect(email.attachments).toEqual([]);
  });

  it("uses the time of import when receivedAt is not given", async () => {
    const { authorId } = await seedAccount();
    const blobId = await uploadRaw(authorId, plainMessage());
    const before = Date.now() - 2000;
    const [, result] = await importOne(authorId, importOf(blobId));
    const email = await getEmail(authorId, result.created.m1.id);
    const received = Date.parse(email.receivedAt);
    expect(received).toBeGreaterThanOrEqual(before);
    expect(received).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("keeps custom folders of the From inbox and defaults keywords to none", async () => {
    const { authorId } = await seedAccount();
    const blobId = await uploadRaw(authorId, plainMessage());
    const [, result] = await importOne(authorId, {
      blobId,
      mailboxIds: { [sys(INBOX, "drafts")]: true, [mbx("f1")]: true },
      keywords: { $draft: true },
    });
    const email = await getEmail(authorId, result.created.m1.id);
    expect(email.mailboxIds).toEqual({
      [sys(INBOX, "drafts")]: true,
      [mbx("f1")]: true,
    });
    expect(email.keywords).toEqual({ $draft: true });
  });

  it("honours ifInState and reports old and new state", async () => {
    const { authorId } = await seedAccount();
    const blobId = await uploadRaw(authorId, plainMessage());
    const mismatch = (await jmapCall(authorId, [
      importCall(authorId, { m1: importOf(blobId) }, { ifInState: "nope" }),
    ])) as Responses;
    expect(mismatch[0]).toEqual(["error", { type: "stateMismatch" }, "i"]);
    const [, result] = await importOne(authorId, importOf(blobId));
    expect(typeof result.oldState).toBe("string");
    expect(result.newState).not.toBe(result.oldState);
    const again = (await jmapCall(authorId, [
      importCall(
        authorId,
        { m1: importOf(blobId) },
        { ifInState: result.newState },
      ),
    ])) as Responses;
    expect(again[0][1].created.m1.id).toMatch(/^D/);
  });

  it("imports into the From inbox's Drafts when aerc names the other inbox's", async () => {
    const { authorId } = await seedAccount();
    await addOtherInbox();
    const blobId = await uploadRaw(authorId, plainMessage(INBOX));
    const [, result] = await importOne(
      authorId,
      importOf(blobId, { mailboxIds: { [sys(OTHER, "drafts")]: true } }),
    );
    const email = await getEmail(authorId, result.created.m1.id);
    expect(email.mailboxIds).toEqual({ [sys(INBOX, "drafts")]: true });
  });

  it("does not remap a custom folder of the other inbox", async () => {
    const { authorId } = await seedAccount();
    await addOtherInbox();
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(mailboxes).values({
      id: "f-other",
      inbox: OTHER,
      name: "Other folder",
      role: null,
      parentId: null,
      sortOrder: 1,
      createdBy: authorId,
      createdAt: now,
      updatedAt: now,
    });
    const blobId = await uploadRaw(authorId, plainMessage(INBOX));
    await expectRefusal(
      authorId,
      importOf(blobId, {
        mailboxIds: {
          [sys(OTHER, "drafts")]: true,
          [mbx("f-other")]: true,
        },
      }),
      { type: "invalidProperties", properties: ["mailboxIds"] },
    );
  });

  it("runs aerc's exact send: import into the other inbox's Drafts, submit with its Sent/Drafts in the patch", async () => {
    const { authorId } = await seedAccount();
    await addOtherInbox();
    const blobId = await uploadRaw(
      authorId,
      plainMessage(INBOX, `Privacy <${OTHER}>`),
    );
    const { sender, calls } = recordingSender(OK);
    const res = (await jmapCall(
      authorId,
      [
        [
          "Email/import",
          {
            accountId: acct(authorId),
            emails: {
              aerc: {
                blobId,
                mailboxIds: { [sys(OTHER, "drafts")]: true },
                keywords: { $draft: true, $seen: true },
              },
            },
          },
          "0",
        ],
        [
          "EmailSubmission/set",
          {
            accountId: acct(authorId),
            create: {
              sub: {
                identityId: idn(INBOX),
                emailId: "#aerc",
                envelope: {
                  mailFrom: { email: INBOX },
                  rcptTo: [{ email: OTHER }],
                },
              },
            },
            onSuccessUpdateEmail: {
              "#sub": {
                "keywords/$draft": null,
                [`mailboxIds/${sys(OTHER, "sent")}`]: true,
                [`mailboxIds/${sys(OTHER, "drafts")}`]: null,
              },
            },
          },
          "1",
        ],
      ],
      { sender },
    )) as Responses;
    expect(res.map(([name]) => name)).toEqual([
      "Email/import",
      "EmailSubmission/set",
      "Email/set",
    ]);
    const emailId = res[0][1].created.aerc.id as string;
    expect(res[1][1].notCreated).toBeNull();
    expect(res[1][1].created.sub.id).toBeTruthy();
    expect(res[2][1].updated).toEqual({ [emailId]: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].from).toContain(INBOX);

    const email = await getEmail(authorId, emailId);
    expect(email.mailboxIds).toEqual({ [sys(INBOX, "sent")]: true });
    expect(email.keywords.$draft).toBeUndefined();
    const sentOwn = (await jmapCall(authorId, [
      [
        "Email/query",
        {
          accountId: acct(authorId),
          filter: { inMailbox: sys(INBOX, "sent") },
        },
        "q",
      ],
    ])) as Responses;
    expect(sentOwn[0][1].ids).toContain(emailId);
  });

  it("sends from the other inbox too (the reverse direction)", async () => {
    const { authorId } = await seedAccount();
    await addOtherInbox();
    const blobId = await uploadRaw(authorId, plainMessage(OTHER, INBOX));
    const res = (await jmapCall(
      authorId,
      [
        importCall(authorId, {
          aerc: importOf(blobId, {
            mailboxIds: { [sys(INBOX, "drafts")]: true },
          }),
        }),
        [
          "EmailSubmission/set",
          {
            accountId: acct(authorId),
            create: { sub: { identityId: idn(OTHER), emailId: "#aerc" } },
            onSuccessUpdateEmail: {
              "#sub": {
                "keywords/$draft": null,
                [`mailboxIds/${sys(INBOX, "sent")}`]: true,
                [`mailboxIds/${sys(INBOX, "drafts")}`]: null,
              },
            },
          },
          "1",
        ],
      ],
      { sender: recordingSender(OK).sender },
    )) as Responses;
    const emailId = res[0][1].created.aerc.id as string;
    expect(res[2][1].updated).toEqual({ [emailId]: null });
    const email = await getEmail(authorId, emailId);
    expect(email.mailboxIds).toEqual({ [sys(OTHER, "sent")]: true });
  });

  it("resolves #creationId from Email/import as emailId in EmailSubmission/set", async () => {
    const { authorId } = await seedAccount();
    const blobId = await uploadRaw(authorId, plainMessage());
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
      { sender: recordingSender(OK).sender },
    )) as Responses;
    const emailId = res[0][1].created.m1.id;
    expect(res[1][1].notCreated).toBeNull();
    expect(res[1][1].created.k1.id).toBeTruthy();
    const [submission] = (
      (await jmapCall(authorId, [
        [
          "EmailSubmission/get",
          { accountId: acct(authorId), ids: [res[1][1].created.k1.id] },
          "g",
        ],
      ])) as Responses
    )[0][1].list;
    expect(submission.emailId).toBe(emailId);
  });

  describe("on-success remap collisions", () => {
    async function sendWithPatch(patch: Record<string, unknown>) {
      const { authorId } = await seedAccount();
      await addOtherInbox();
      const blobId = await uploadRaw(authorId, plainMessage(INBOX));
      const res = (await jmapCall(
        authorId,
        [
          importCall(authorId, { aerc: importOf(blobId) }),
          [
            "EmailSubmission/set",
            {
              accountId: acct(authorId),
              create: { sub: { identityId: idn(INBOX), emailId: "#aerc" } },
              onSuccessUpdateEmail: { "#sub": patch },
            },
            "1",
          ],
        ],
        { sender: recordingSender(OK).sender },
      )) as Responses;
      const emailId = res[0][1].created.aerc.id as string;
      return { authorId, emailId, implicit: res[2][1] };
    }

    it.each([
      [
        "own Sent first",
        () => ({
          [`mailboxIds/${sys(INBOX, "sent")}`]: true,
          [`mailboxIds/${sys(OTHER, "sent")}`]: true,
          [`mailboxIds/${sys(OTHER, "drafts")}`]: null,
          "keywords/$draft": null,
        }),
      ],
      [
        "other Sent first",
        () => ({
          [`mailboxIds/${sys(OTHER, "sent")}`]: true,
          [`mailboxIds/${sys(INBOX, "sent")}`]: true,
          [`mailboxIds/${sys(INBOX, "drafts")}`]: null,
          [`mailboxIds/${sys(OTHER, "drafts")}`]: null,
          "keywords/$draft": null,
        }),
      ],
      [
        "whole-object mailboxIds",
        () => ({
          mailboxIds: { [sys(OTHER, "sent")]: true },
          "keywords/$draft": null,
        }),
      ],
      [
        "whole-object mailboxIds naming both Sents",
        () => ({
          mailboxIds: {
            [sys(OTHER, "sent")]: true,
            [sys(INBOX, "sent")]: true,
          },
          "keywords/$draft": null,
        }),
      ],
    ])("files into the own Sent (%s)", async (_label, patch) => {
      const { authorId, emailId, implicit } = await sendWithPatch(patch());
      expect(implicit.updated).toEqual({ [emailId]: null });
      const email = await getEmail(authorId, emailId);
      expect(email.mailboxIds).toEqual({ [sys(INBOX, "sent")]: true });
    });

    it.each([
      [
        "other Drafts null, own Drafts true",
        () => ({
          [`mailboxIds/${sys(OTHER, "drafts")}`]: null,
          [`mailboxIds/${sys(INBOX, "drafts")}`]: true,
          [`mailboxIds/${sys(OTHER, "sent")}`]: true,
          "keywords/$draft": null,
        }),
      ],
      [
        "own Drafts true, other Drafts null",
        () => ({
          [`mailboxIds/${sys(INBOX, "drafts")}`]: true,
          [`mailboxIds/${sys(OTHER, "drafts")}`]: null,
          [`mailboxIds/${sys(OTHER, "sent")}`]: true,
          "keywords/$draft": null,
        }),
      ],
    ])(
      "applies a conflicting pair as sent, like a plain Email/set: own Drafts stays, so filing into Sent is refused (%s)",
      async (_label, patch) => {
        const { authorId, emailId, implicit } = await sendWithPatch(patch());
        expect(implicit.updated).toBeNull();
        expect(implicit.notUpdated[emailId].type).toBe("invalidProperties");
        const email = await getEmail(authorId, emailId);
        expect(email.mailboxIds).toEqual({ [sys(INBOX, "drafts")]: true });
      },
    );

    it.each([
      [
        "own Sent true, other Sent null",
        () => ({
          [`mailboxIds/${sys(INBOX, "sent")}`]: true,
          [`mailboxIds/${sys(OTHER, "sent")}`]: null,
          [`mailboxIds/${sys(INBOX, "drafts")}`]: null,
          "keywords/$draft": null,
        }),
      ],
      [
        "other Sent null, own Sent true",
        () => ({
          [`mailboxIds/${sys(OTHER, "sent")}`]: null,
          [`mailboxIds/${sys(INBOX, "sent")}`]: true,
          [`mailboxIds/${sys(INBOX, "drafts")}`]: null,
          "keywords/$draft": null,
        }),
      ],
    ])(
      "applies a conflicting pair as sent, like a plain Email/set: the foreign null is a no-op and the own Sent applies (%s)",
      async (_label, patch) => {
        const { authorId, emailId, implicit } = await sendWithPatch(patch());
        expect(implicit.updated).toEqual({ [emailId]: null });
        const email = await getEmail(authorId, emailId);
        expect(email.mailboxIds).toEqual({ [sys(INBOX, "sent")]: true });
      },
    );
  });

  describe("refusals store nothing", () => {
    it("refuses a blob the caller can't read", async () => {
      const { authorId, memberId } = await seedAccount();
      const blobId = await uploadRaw(authorId, plainMessage());
      await expectRefusal(memberId, importOf(blobId), {
        type: "invalidProperties",
        properties: ["blobId"],
      });
      await expectRefusal(authorId, importOf("Gnothere"), {
        type: "invalidProperties",
        properties: ["blobId"],
      });
    });

    const signedBody = lines(
      'Content-Type: multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256; boundary="sig"',
      "",
      "--sig",
      "Content-Type: text/plain",
      "",
      "Signed text.",
      "--sig",
      "Content-Type: application/pgp-signature",
      "",
      "-----BEGIN PGP SIGNATURE-----",
      "--sig--",
    );
    const encryptedBody = lines(
      'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc"',
      "",
      "--enc",
      "Content-Type: application/pgp-encrypted",
      "",
      "Version: 1",
      "--enc",
      "Content-Type: application/octet-stream",
      "",
      "-----BEGIN PGP MESSAGE-----",
      "--enc--",
    );
    const nested = (inner: string) =>
      lines(
        'Content-Type: multipart/mixed; boundary="outer"',
        "",
        "--outer",
        "Content-Type: text/plain",
        "",
        "Cover note.",
        "--outer",
        inner,
        "--outer--",
      );

    it.each([
      ["multipart/signed at the top", signedBody],
      ["multipart/signed inside multipart/mixed", nested(signedBody)],
      ["multipart/encrypted at the top", encryptedBody],
      ["multipart/encrypted inside multipart/mixed", nested(encryptedBody)],
      [
        "application/pkcs7-mime",
        lines(
          'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
          "Content-Transfer-Encoding: base64",
          "",
          "AAAA",
        ),
      ],
      [
        "two inline text/plain parts",
        lines(
          'Content-Type: multipart/mixed; boundary="two"',
          "",
          "--two",
          "Content-Type: text/plain",
          "",
          "One.",
          "--two",
          "Content-Type: text/plain",
          "Content-Disposition: inline",
          "",
          "Two.",
          "--two--",
        ),
      ],
      [
        "multipart/signed with a comment after the type",
        signedBody.replace("multipart/signed;", "multipart/signed (detached);"),
      ],
      [
        "a repeated Content-Type at the top",
        lines("Content-Type: text/plain", "Content-Type: text/html", "", "x"),
      ],
      [
        "a repeated Content-Transfer-Encoding in a nested part",
        lines(
          'Content-Type: multipart/mixed; boundary="rep"',
          "",
          "--rep",
          "Content-Type: text/plain",
          "",
          "Body.",
          "--rep",
          "Content-Type: application/octet-stream",
          "Content-Transfer-Encoding: base64",
          "Content-Transfer-Encoding: 7bit",
          "Content-Disposition: attachment",
          "",
          "AAAA",
          "--rep--",
        ),
      ],
      [
        "a repeated Content-Disposition in a nested part",
        lines(
          'Content-Type: multipart/mixed; boundary="rep"',
          "",
          "--rep",
          "Content-Type: text/plain",
          "Content-Disposition: inline",
          "Content-Disposition: attachment",
          "",
          "Body.",
          "--rep--",
        ),
      ],
    ])("refuses %s with invalidEmail", async (_label, body) => {
      const { authorId } = await seedAccount();
      const raw = lines(...headers(), body, "");
      const blobId = await uploadRaw(authorId, raw);
      const error = await expectRefusal(authorId, importOf(blobId), {
        type: "invalidEmail",
      });
      expect(error.description).toBeTruthy();
    });

    it("refuses a header the draft path can't store with invalidEmail naming it", async () => {
      const { authorId } = await seedAccount();
      const raw = lines(
        `From: ${INBOX}`,
        "To: alice@example.com",
        `Subject: ${"s".repeat(901)}`,
        "Content-Type: text/plain",
        "",
        "Body.",
        "",
      );
      const blobId = await uploadRaw(authorId, raw);
      const error = await expectRefusal(authorId, importOf(blobId), {
        type: "invalidEmail",
      });
      expect(error.description).toContain("subject");
    });

    it("refuses a tree deeper than 10 levels or wider than 100 parts", async () => {
      const { authorId } = await seedAccount();
      let deep = lines("Content-Type: text/plain", "", "Leaf.");
      for (let level = 0; level < 11; level += 1) {
        deep = lines(
          `Content-Type: multipart/mixed; boundary="b${level}"`,
          "",
          `--b${level}`,
          deep,
          `--b${level}--`,
        );
      }
      const deepBlob = await uploadRaw(authorId, lines(...headers(), deep, ""));
      await expectRefusal(authorId, importOf(deepBlob), {
        type: "invalidEmail",
      });

      const wide = [
        'Content-Type: multipart/mixed; boundary="w"',
        "",
        ...Array.from({ length: 101 }, (_, i) =>
          lines(
            "--w",
            "Content-Type: application/octet-stream",
            "Content-Disposition: attachment",
            "",
            `part ${i}`,
          ),
        ),
        "--w--",
      ];
      const wideBlob = await uploadRaw(
        authorId,
        lines(...headers(), ...wide, ""),
      );
      await expectRefusal(authorId, importOf(wideBlob), {
        type: "invalidEmail",
      });
    });

    it("refuses 33 attachments with tooLarge", async () => {
      const { authorId } = await seedAccount();
      const body = [
        'Content-Type: multipart/mixed; boundary="many"',
        "",
        "--many",
        "Content-Type: text/plain",
        "",
        "Many files.",
        ...Array.from({ length: 33 }, (_, i) =>
          lines(
            "--many",
            `Content-Type: application/octet-stream; name="f${i}.bin"`,
            `Content-Disposition: attachment; filename="f${i}.bin"`,
            "",
            `file ${i}`,
          ),
        ),
        "--many--",
      ];
      const blobId = await uploadRaw(
        authorId,
        lines(...headers(), ...body, ""),
      );
      await expectRefusal(authorId, importOf(blobId), { type: "tooLarge" });
    });

    it("refuses a message over the size limit with tooLarge", async () => {
      const { authorId } = await seedAccount();
      const blobId = await uploadRaw(authorId, fullMessage());
      const small = recordingSender(OK).sender;
      small.maxAttachmentBytes = () => 200;
      await expectRefusal(
        authorId,
        importOf(blobId),
        { type: "tooLarge" },
        { sender: small },
      );
    });

    it.each([
      ["the Inbox", () => ({ [sys(INBOX, "inbox")]: true })],
      [
        "Sent next to Drafts",
        () => ({ [sys(INBOX, "drafts")]: true, [sys(INBOX, "sent")]: true }),
      ],
      ["Trash", () => ({ [sys(INBOX, "trash")]: true })],
      ["a custom folder only", () => ({ [mbx("f1")]: true })],
    ])("refuses a target of %s with forbidden", async (_label, target) => {
      const { authorId } = await seedAccount();
      const blobId = await uploadRaw(authorId, plainMessage());
      await expectRefusal(
        authorId,
        importOf(blobId, { mailboxIds: target() }),
        {
          type: "forbidden",
          description: "Email/import only creates drafts",
        },
      );
    });

    it("refuses keywords without $draft with forbidden", async () => {
      const { authorId } = await seedAccount();
      const blobId = await uploadRaw(authorId, plainMessage());
      await expectRefusal(
        authorId,
        importOf(blobId, { keywords: { $seen: true } }),
        { type: "forbidden" },
      );
      await expectRefusal(
        authorId,
        { blobId, mailboxIds: { [sys(INBOX, "drafts")]: true } },
        { type: "forbidden" },
      );
    });

    it.each([
      ["an unknown property", { headers: [] }, ["headers"]],
      ["blobId of the wrong type", { blobId: 7 }, ["blobId"]],
      ["null blobId", { blobId: null }, ["blobId"]],
      ["mailboxIds of the wrong type", { mailboxIds: ["x"] }, ["mailboxIds"]],
      [
        "a false mailboxIds value",
        { mailboxIds: { [sys(INBOX, "drafts")]: false } },
        ["mailboxIds"],
      ],
      ["null keywords", { keywords: null }, ["keywords"]],
      ["keywords of the wrong type", { keywords: "$draft" }, ["keywords"]],
      [
        "a non-UTC receivedAt",
        { receivedAt: "2026-09-20T08:30:00+02:00" },
        ["receivedAt"],
      ],
      ["a malformed receivedAt", { receivedAt: "yesterday" }, ["receivedAt"]],
      ["null receivedAt", { receivedAt: null }, ["receivedAt"]],
    ])(
      "refuses %s with invalidProperties",
      async (_label, overrides, properties) => {
        const { authorId } = await seedAccount();
        const blobId = await uploadRaw(authorId, plainMessage());
        await expectRefusal(authorId, importOf(blobId, overrides), {
          type: "invalidProperties",
          properties,
        });
      },
    );

    it("refuses a From that is not one of the caller's identities, as Email/set does", async () => {
      const { authorId } = await seedAccount();
      const blobId = await uploadRaw(
        authorId,
        plainMessage("stranger@example.com"),
      );
      const setRes = (await jmapCall(authorId, [
        [
          "Email/set",
          {
            accountId: acct(authorId),
            create: {
              d1: draftCreate({
                from: [{ email: "stranger@example.com" }],
              }),
            },
          },
          "a",
        ],
      ])) as Responses;
      const setError = setRes[0][1].notCreated.d1;
      await expectRefusal(authorId, importOf(blobId), setError);
    });

    it("refuses more than maxObjectsInSet emails with requestTooLarge, and an empty or missing emails", async () => {
      const { authorId } = await seedAccount();
      const blobId = await uploadRaw(authorId, plainMessage());
      const emails = Object.fromEntries(
        Array.from({ length: MAX_OBJECTS_IN_SET + 1 }, (_, i) => [
          `m${i}`,
          importOf(blobId),
        ]),
      );
      const before = await snapshot(authorId);
      const res = (await jmapCall(authorId, [
        importCall(authorId, emails),
        importCall(authorId, {}),
        ["Email/import", { accountId: acct(authorId) }, "x"],
      ])) as Responses;
      expect(res[0][0]).toBe("error");
      expect(res[0][1].type).toBe("requestTooLarge");
      expect(res[1][1]).toMatchObject({
        type: "invalidArguments",
        properties: ["emails"],
      });
      expect(res[2][1]).toMatchObject({
        type: "invalidArguments",
        properties: ["emails"],
      });
      expect(await snapshot(authorId)).toEqual(before);
    });

    it("refuses the wrong account", async () => {
      const { authorId } = await seedAccount();
      const res = (await jmapCall(authorId, [
        ["Email/import", { accountId: "nope", emails: {} }, "x"],
      ])) as Responses;
      expect(res[0][1].type).toBe("accountNotFound");
    });
  });

  it("imports 120 messages in one call (lists reaching SQL stay chunked)", async () => {
    const { authorId } = await seedAccount();
    const blobIds: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      blobIds.push(await uploadRaw(authorId, plainMessage()));
    }
    const res = (await jmapCall(authorId, [
      importCall(
        authorId,
        Object.fromEntries(
          blobIds.map((blobId, i) => [`m${i}`, importOf(blobId)]),
        ),
      ),
    ])) as Responses;
    expect(res[0][1].notCreated).toBeNull();
    expect(Object.keys(res[0][1].created)).toHaveLength(120);
    expect((await getDb().select().from(jmapDrafts)).length).toBe(120);
  });
});

describe("raw MIME scan", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("finds the body parts and leaves of a nested tree", () => {
    const raw = encode(fullMessage());
    const scan = scanMimeStructure(raw);
    expect(scan.error).toBeNull();
    expect(scan.textLeaf?.type).toBe("text/plain");
    expect(scan.htmlLeaf?.type).toBe("text/html");
    expect(scan.attachmentLeaves.map((leaf) => leaf.type)).toEqual([
      "image/png",
      "application/pdf",
      "message/rfc822",
    ]);
    expect(scan.attachmentLeaves[0]).toMatchObject({
      cid: "logo@import",
      disposition: "inline",
      inRelated: true,
    });
    expect(decodeLeafBody(raw, scan.attachmentLeaves[0])).toEqual(PNG);
    expect(decodeLeafBody(raw, scan.attachmentLeaves[1])).toEqual(PDF);
  });

  it("does not look inside an attached message", () => {
    const inner = lines(
      'Content-Type: multipart/signed; boundary="s"',
      "",
      "--s",
      "Content-Type: text/plain",
      "",
      "x",
      "--s--",
    );
    const raw = lines(
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      "Content-Type: text/plain",
      "",
      "Cover.",
      "--m",
      "Content-Type: message/rfc822",
      "",
      inner,
      "--m--",
    );
    const scan = scanMimeStructure(encode(raw));
    expect(scan.error).toBeNull();
    expect(scan.attachmentLeaves).toHaveLength(1);
  });

  it("counts an attached text/plain as an attachment, not a second body", () => {
    const raw = lines(
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      "Content-Type: text/plain",
      "",
      "Body.",
      "--m",
      "Content-Type: text/plain",
      'Content-Disposition: attachment; filename="notes.txt"',
      "",
      "Notes.",
      "--m--",
    );
    const scan = scanMimeStructure(encode(raw));
    expect(scan.error).toBeNull();
    expect(scan.attachmentLeaves).toHaveLength(1);
  });

  it("handles LF-only line endings and quoted-printable soft breaks", () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      "Content-Type: text/plain",
      "",
      "Body.",
      "--m",
      "Content-Type: application/octet-stream",
      "Content-Transfer-Encoding: quoted-printable",
      "Content-Disposition: attachment",
      "",
      "a=3Db=",
      "c=FF",
      "--m--",
    ].join("\n");
    const bytes = encode(raw);
    const scan = scanMimeStructure(bytes);
    expect(scan.error).toBeNull();
    expect(Array.from(decodeLeafBody(bytes, scan.attachmentLeaves[0]))).toEqual(
      [0x61, 0x3d, 0x62, 0x63, 0xff],
    );
  });

  it("strips RFC 822 comments from a Content-Type, but not inside quotes", () => {
    expect(stripComments('multipart/signed(x (nested)); boundary="a(b)"')).toBe(
      'multipart/signed; boundary="a(b)"',
    );
    const parsed = parseHeaderValue(
      'multipart/signed (detached) ; boundary="a(b)"',
    );
    expect(parsed.value).toBe("multipart/signed");
    expect(parsed.params.get("boundary")).toBe("a(b)");
  });

  it("parses Message-ID lists", () => {
    expect(parseMessageIdList("<a@b> <c@d>")).toEqual(["a@b", "c@d"]);
    expect(parseMessageIdList("bare@id")).toEqual(["bare@id"]);
    expect(parseMessageIdList(undefined)).toEqual([]);
  });
});

describe("Email/import review fixes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  async function importRaw(userId: string, raw: string) {
    const blobId = await uploadRaw(userId, raw);
    const [, result] = await importOne(userId, importOf(blobId));
    return result;
  }

  it("refuses a repeated boundary parameter that would hide a nested multipart/signed", async () => {
    const { authorId } = await seedAccount();
    const result = await importRaw(
      authorId,
      lines(
        ...headers(),
        'Content-Type: multipart/mixed; boundary="seen"; boundary="real"',
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
      ),
    );
    expect(result.created).toBeNull();
    expect(result.notCreated.m1.type).toBe("invalidEmail");
    expect(result.notCreated.m1.description).toContain("boundary");
    expect((await getDb().select().from(jmapDrafts)).length).toBe(0);
  });

  it.each([
    [
      "a repeated charset",
      "Content-Type: text/plain; charset=utf-8; CHARSET=iso-8859-1",
      "",
    ],
    [
      "a repeated filename",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="a.pdf"; filename="b.pdf"',
    ],
    [
      "a filename given plainly and in RFC 2231 form",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename=a.pdf; filename*=utf-8''b.pdf",
    ],
  ])("refuses %s with invalidEmail", async (_label, type, disposition) => {
    const { authorId } = await seedAccount();
    const result = await importRaw(
      authorId,
      lines(
        ...headers(),
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "--m",
        "Content-Type: text/plain",
        "",
        "Body.",
        "--m",
        type,
        ...(disposition ? [disposition] : []),
        "",
        "Part.",
        "--m--",
        "",
      ),
    );
    expect(result.created).toBeNull();
    expect(result.notCreated.m1.type).toBe("invalidEmail");
  });

  it("decodes a commented Content-Transfer-Encoding as postal-mime does: the attachment downloads byte-identical", async () => {
    const { authorId } = await seedAccount();
    const result = await importRaw(
      authorId,
      lines(
        ...headers(),
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "--m",
        "Content-Type: text/plain",
        "Content-Transfer-Encoding: 7bit (plain)",
        "",
        "Body.",
        "--m",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="report.pdf"',
        "Content-Transfer-Encoding: base64 (x)",
        "",
        b64(PDF),
        "--m--",
        "",
      ),
    );
    expect(result.notCreated).toBeNull();
    const email = await getEmail(authorId, result.created.m1.id);
    expect(email.attachments).toHaveLength(1);
    expect(await blobBytes(authorId, email.attachments[0].blobId)).toEqual(PDF);
  });

  it("refuses a transfer encoding neither side decodes the same way", async () => {
    const { authorId } = await seedAccount();
    const result = await importRaw(
      authorId,
      lines(
        ...headers(),
        "Content-Type: text/plain",
        "Content-Transfer-Encoding: x-uuencode",
        "",
        "begin 644 x",
        "",
      ),
    );
    expect(result.notCreated.m1.type).toBe("invalidEmail");
    expect(transferEncodingToken(" Base64 (x)")).toBe("base64");
    expect(transferEncodingToken("quoted-printable")).toBe("quoted-printable");
  });

  it("checks the bytes read, not the recorded size: a received raw message with no raw_size is still tooLarge", async () => {
    const { authorId } = await seedAccount();
    await createTestPerson();
    await createTestEmail({ id: "big", recipient: INBOX });
    const rawKey = "raw/big.eml";
    await env.R2.put(rawKey, plainMessage() + "x".repeat(2000));
    await getDb()
      .update(emails)
      .set({ rawR2Key: rawKey, rawSize: null })
      .where(eq(emails.id, "big"));
    const small = recordingSender(OK).sender;
    small.maxAttachmentBytes = () => 1000;
    const [, result] = await importOne(
      authorId,
      importOf(publicReceivedRawBlobId("big")),
      { sender: small },
    );
    expect(result.created).toBeNull();
    expect(result.notCreated.m1.type).toBe("tooLarge");
    expect((await getDb().select().from(jmapDrafts)).length).toBe(0);
    expect((await getDb().select().from(jmapMessageContent)).length).toBe(0);
  });

  it("threads a reply for a member with 33 inboxes (the inbox list is bound once)", async () => {
    const { memberId } = await seedAccount();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 32; i += 1) {
      await getDb()
        .insert(inboxPermissions)
        .values({
          userId: memberId,
          email: `extra${i}@saasmail.test`,
          createdAt: now,
          createdBy: null,
        });
    }
    await createTestPerson();
    await createTestEmail({
      id: "orig",
      recipient: INBOX,
      messageId: "<orig-1@example.com>",
      conversationId: "c_0123456789abcdef",
    });
    const blobId = await uploadRaw(memberId, fullMessage());
    const [, imported] = await importOne(memberId, importOf(blobId));
    expect(imported.notCreated).toBeNull();
    expect(imported.created.m1.threadId).toBe(thread("c_0123456789abcdef"));

    const set = (await jmapCall(memberId, [
      [
        "Email/set",
        { accountId: acct(memberId), create: { d1: draftCreate() } },
        "a",
      ],
    ])) as Responses;
    expect(set[0][1].notCreated).toBeNull();
    expect(set[0][1].created.d1.threadId).toBe(thread("c_0123456789abcdef"));
  });
});
