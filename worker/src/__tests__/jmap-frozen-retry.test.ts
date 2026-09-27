import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { acct, idn } from "./jmap-ids";
import { outboxEmails } from "../db/outbox-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { attemptOutboxRow } from "../lib/outbox";
import { uploadBlob } from "./jmap-harness";
import {
  INBOX,
  OK,
  TERMINAL,
  TRANSIENT,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

/** Upload a file through the real JMAP upload route and return its blob id. */
function upload(userId: string, apiKey: string, bytes: string, type: string) {
  return uploadBlob(userId, apiKey, new TextEncoder().encode(bytes), type);
}

async function retryingSubmission(
  authorId: string,
  apiKey: string,
  { imageName = "logo.png" }: { imageName?: string | null } = {},
) {
  const image = await upload(authorId, apiKey, "PNGDATA", "image/png");
  const file = await upload(authorId, apiKey, "PDFDATA", "application/pdf");
  const first = recordingSender(TRANSIENT);
  await jmapCall(
    authorId,
    [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          create: {
            d1: draftCreate({
              textBody: undefined,
              bodyValues: {
                h: { value: '<p>See <img src="cid:logo@x"></p>' },
              },
              htmlBody: [{ partId: "h", type: "text/html" }],
              attachments: [
                {
                  blobId: image,
                  type: "image/png",
                  ...(imageName ? { name: imageName } : {}),
                  cid: "logo@x",
                  disposition: "inline",
                },
                { blobId: file, type: "application/pdf", name: "q3.pdf" },
              ],
            }),
          },
        },
        "a",
      ],
      [
        "EmailSubmission/set",
        {
          accountId: acct(authorId),
          create: { k1: { identityId: idn(INBOX), emailId: "#d1" } },
        },
        "b",
      ],
    ],
    { sender: first.sender },
  );
  const [row] = await getDb().select().from(outboxEmails);
  await getDb()
    .update(outboxEmails)
    .set({ nextRetryAt: 0 })
    .where(eq(outboxEmails.id, row.id));
  return {
    first: first.calls[0],
    outboxId: row.id,
    sentEmailId: row.sentEmailId,
  };
}

describe("frozen-content retries of JMAP outbox rows", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("replays the exact first attempt after the identity name changes", async () => {
    const { authorId, authorApiKey } = await seedAccount();
    const { first, outboxId } = await retryingSubmission(
      authorId,
      authorApiKey,
    );
    await getDb()
      .update(senderIdentities)
      .set({ displayName: "Renamed" })
      .where(eq(senderIdentities.email, INBOX));

    const retry = recordingSender(OK);
    expect(await attemptOutboxRow(getDb(), env, retry.sender, outboxId)).toBe(
      "sent",
    );
    const again = retry.calls[0];
    expect(again.from).toBe(first.from);
    expect(again.from).toContain("Hello Team");
    expect(again.to).toBe(first.to);
    expect(again.to).toContain("Alice Example");
    expect(again.cc).toEqual(first.cc);
    expect(again.headers?.References).toBe(first.headers?.References);
    expect(again.headers?.["In-Reply-To"]).toBe(first.headers?.["In-Reply-To"]);
    expect(again.headers?.["Message-ID"]).toBe(first.headers?.["Message-ID"]);
    expect(again.headers?.Date).toBe(first.headers?.Date);
    expect(again.html).toBe(first.html);
    expect(again.text).toBe(first.text);
    expect(again.subject).toBe(first.subject);
    const shape = (list: typeof again.attachments) =>
      (list ?? []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        contentId: a.contentId ?? null,
        disposition: a.disposition ?? "attachment",
        bytes: new TextDecoder().decode(a.content as ArrayBuffer),
      }));
    expect(shape(again.attachments)).toEqual(shape(first.attachments));
    expect(shape(again.attachments)).toContainEqual(
      expect.objectContaining({ contentId: "logo@x", disposition: "inline" }),
    );
  });

  it("names an unnamed part the same way on the retry as on the first attempt", async () => {
    const { authorId, authorApiKey } = await seedAccount();
    const { first, outboxId } = await retryingSubmission(
      authorId,
      authorApiKey,
      { imageName: null },
    );
    const retry = recordingSender(OK);
    expect(await attemptOutboxRow(getDb(), env, retry.sender, outboxId)).toBe(
      "sent",
    );
    const names = (list: typeof first.attachments) =>
      (list ?? []).map((a) => a.filename);
    expect(names(first.attachments)).toEqual(["attachment-2", "q3.pdf"]);
    expect(names(retry.calls[0].attachments)).toEqual(names(first.attachments));
  });

  it("holds the row and upgrades the Sent row after a later success", async () => {
    const { authorId, authorApiKey } = await seedAccount();
    const { outboxId, sentEmailId } = await retryingSubmission(
      authorId,
      authorApiKey,
    );
    await attemptOutboxRow(getDb(), env, recordingSender(OK).sender, outboxId);
    const [held] = await getDb().select().from(outboxEmails);
    expect(held.status).toBe("bookkeeping_pending");
    const [sent] = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, sentEmailId));
    expect(sent.status).toBe("sent");
  });

  it("marks the visible Sent row failed after a later terminal failure", async () => {
    const { authorId, authorApiKey } = await seedAccount();
    const { outboxId, sentEmailId } = await retryingSubmission(
      authorId,
      authorApiKey,
    );
    expect(
      await attemptOutboxRow(
        getDb(),
        env,
        recordingSender(TERMINAL).sender,
        outboxId,
      ),
    ).toBe("failed");
    const [sent] = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, sentEmailId));
    expect(sent.status).toBe("failed");
    const [submission] = await getDb().select().from(jmapSubmissions);
    expect(submission.attemptState).toBe("accepted");
  });

  it("falls back to the stored outbox fields when the intention is gone", async () => {
    const { authorId, authorApiKey } = await seedAccount();
    const { outboxId } = await retryingSubmission(authorId, authorApiKey);
    await getDb().delete(jmapSubmissions);
    const retry = recordingSender(OK);
    expect(await attemptOutboxRow(getDb(), env, retry.sender, outboxId)).toBe(
      "sent",
    );
    expect(retry.calls).toHaveLength(1);
  });

  it("leaves a non-JMAP outbox row on the stored fields", async () => {
    const { authorId, authorApiKey } = await seedAccount();
    const { first, outboxId } = await retryingSubmission(
      authorId,
      authorApiKey,
    );
    // Owner null: an ordinary web/campaign row, which never freezes content.
    await getDb()
      .update(outboxEmails)
      .set({ bookkeepingOwner: null, nextRetryAt: 0 })
      .where(eq(outboxEmails.id, outboxId));
    const retry = recordingSender(OK);
    expect(await attemptOutboxRow(getDb(), env, retry.sender, outboxId)).toBe(
      "sent",
    );
    const again = retry.calls[0];
    // The stored fields hold the bare To and no per-part disposition, so this
    // is exactly what an unowned row has always done.
    expect(again.to).toBe("alice@example.com");
    expect(again.to).not.toContain("Alice Example");
    expect(
      (again.attachments ?? []).map((a) => [
        a.filename,
        a.contentId ?? null,
        a.disposition,
      ]),
    ).toEqual([
      ["logo.png", null, undefined],
      ["q3.pdf", null, undefined],
    ]);
    expect(first.to).toContain("Alice Example");
  });
});
