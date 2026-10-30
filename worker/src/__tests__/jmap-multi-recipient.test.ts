// Several To addresses and Bcc through EmailSubmission/set, for a provider that
// delivers them (EmailSender.recipientSupport).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import type { EmailSender, SendEmailResult } from "../lib/email-sender";
import { attemptOutboxRow } from "../lib/outbox";
import { parseRawBlobId } from "../jmap/public-ids";
import {
  MINE,
  OK,
  TRANSIENT,
  addIdentity,
  createDraft,
  recordingSender,
  runJmap,
  submitCall,
} from "./jmap-harness";
import { acct } from "./jmap-ids";

function capable(results: SendEmailResult[] = [OK]) {
  const { sender, calls } = recordingSender(results);
  const withSupport: EmailSender = {
    ...sender,
    send: (params) => sender.send(params),
    recipientSupport: () => ({ multipleTo: true, bcc: true }),
  };
  return { sender: withSupport, calls };
}

const RECIPIENTS = {
  to: [
    { name: "Bob Example", email: "bob@example.com" },
    { name: "Carol, Jr.", email: "carol@example.com" },
  ],
  cc: [{ name: null, email: "dee@example.com" }],
  bcc: [{ name: "Hidden", email: "hidden@example.com" }],
};

function result(responses: unknown[][], callId = "s") {
  return responses.find((r) => r[2] === callId)![1] as Record<string, any>;
}

async function sentRowFor(blobId: string) {
  const [row] = await getDb()
    .select()
    .from(sentEmails)
    .where(eq(sentEmails.jmapContentId, parseRawBlobId(blobId)!));
  return row;
}

describe("EmailSubmission with several To and Bcc", () => {
  let userId: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ userId } = await createTestUser({ id: "multi-user" }));
    await addIdentity(MINE);
  });

  it("sends to every To, Cc and Bcc, Bcc only in the envelope, and records them", async () => {
    const { sender, calls } = capable();
    const draft = await createDraft(userId, sender, RECIPIENTS);
    const responses = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      sender,
    );
    const created = result(responses).created.s1;
    expect(created).toBeDefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe("Bob Example <bob@example.com>");
    expect(calls[0].additionalTo).toEqual(['"Carol, Jr." <carol@example.com>']);
    expect(calls[0].cc).toEqual(["dee@example.com"]);
    expect(calls[0].bcc).toEqual(["Hidden <hidden@example.com>"]);
    expect(JSON.stringify(calls[0].headers)).not.toMatch(/hidden@example\.com/);

    const [get] = await runJmap(
      userId,
      [
        [
          "EmailSubmission/get",
          { accountId: acct(userId), ids: [created.id] },
          "g",
        ],
      ],
      sender,
    );
    const [submission] = (get[1] as Record<string, any>).list;
    expect(
      submission.envelope.rcptTo.map((r: { email: string }) => r.email).sort(),
    ).toEqual([
      "bob@example.com",
      "carol@example.com",
      "dee@example.com",
      "hidden@example.com",
    ]);

    const sent = await sentRowFor(draft.blobId);
    expect(sent.toAddress).toBe("bob@example.com");
    expect(JSON.parse(sent.additionalTo!)).toEqual([
      { email: "carol@example.com", name: "Carol, Jr." },
    ]);
    expect(JSON.parse(sent.bcc!)).toEqual([
      { email: "hidden@example.com", name: "Hidden" },
    ]);
  });

  it("an outbox retry still reaches every To and the Bcc", async () => {
    const first = capable([TRANSIENT]);
    const draft = await createDraft(userId, first.sender, RECIPIENTS);
    await runJmap(userId, [submitCall(userId, draft.id)], first.sender);
    const queued = await sentRowFor(draft.blobId);
    const [row] = await getDb()
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, queued.id));
    expect(JSON.parse(row.bcc!)).toEqual([
      { email: "hidden@example.com", name: "Hidden" },
    ]);
    await getDb()
      .update(outboxEmails)
      .set({ nextRetryAt: 0 })
      .where(eq(outboxEmails.id, row.id));

    const retry = capable();
    expect(await attemptOutboxRow(getDb(), env, retry.sender, row.id)).toBe(
      "sent",
    );
    expect(retry.calls[0].additionalTo).toEqual([
      '"Carol, Jr." <carol@example.com>',
    ]);
    expect(retry.calls[0].bcc).toEqual(["Hidden <hidden@example.com>"]);
  });

  it("a supplied envelope must include the Bcc", async () => {
    const { sender, calls } = capable();
    const draft = await createDraft(userId, sender, RECIPIENTS);
    const responses = await runJmap(
      userId,
      [
        submitCall(userId, draft.id, {
          envelope: {
            mailFrom: { email: MINE, parameters: null },
            rcptTo: [
              { email: "bob@example.com", parameters: null },
              { email: "carol@example.com", parameters: null },
              { email: "dee@example.com", parameters: null },
            ],
          },
        }),
      ],
      sender,
    );
    expect(result(responses).notCreated.s1).toMatchObject({
      type: "invalidEmail",
      properties: ["to", "cc", "bcc"],
    });
    expect(calls).toHaveLength(0);
  });
});
