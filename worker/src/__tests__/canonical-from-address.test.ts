import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestPerson,
  createTestTemplate,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { processSequenceEmail } from "../lib/sequence-processor";
import { queryMessages } from "../lib/messages/query";
import type { EmailSender, SendEmailParams } from "../lib/email-sender";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";

const INBOX = "hello@example.com";

describe("canonical sequence sending inboxes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("normalizes a legacy mixed-case enrollment before Sent and JMAP reads", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "mixed-sequence-member",
      role: "member",
      email: "mixed-sequence-member@example.com",
    });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(inboxPermissions).values({
      userId,
      email: INBOX,
      createdAt: now,
      createdBy: null,
    });
    await createTestPerson({
      id: "mixed-sequence-person",
      email: "recipient@example.net",
    });
    await createTestTemplate({ slug: "mixed-welcome" });
    await db.insert(sequences).values({
      id: "mixed-sequence",
      name: "Mixed",
      steps: JSON.stringify([
        { order: 1, templateSlug: "mixed-welcome", delayHours: 0 },
      ]),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sequenceEnrollments).values({
      id: "mixed-enrollment",
      sequenceId: "mixed-sequence",
      personId: "mixed-sequence-person",
      status: "active",
      variables: "{}",
      fromAddress: "Hello@Example.com",
      enrolledAt: now,
    });
    await db.insert(sequenceEmails).values({
      id: "mixed-step",
      enrollmentId: "mixed-enrollment",
      stepOrder: 1,
      templateSlug: "mixed-welcome",
      scheduledAt: now,
      status: "queued",
    });

    const sender: EmailSender = {
      provider: "none",
      maxAttachmentBytes: () => 25_000_000,
      send: vi.fn(async (_params: SendEmailParams) => ({
        id: "mixed-provider-id",
        error: null,
      })),
    };
    await processSequenceEmail(
      db,
      sender,
      env as unknown as CloudflareBindings,
      "mixed-step",
    );

    const sent = await db.select().from(sentEmails);
    expect(sent).toHaveLength(1);
    expect(sent[0].fromAddress).toBe(INBOX);

    const page = await queryMessages(
      db,
      { isAdmin: false, inboxes: [INBOX] },
      {
        inboxes: [INBOX],
        folder: "sent",
        viewer: { userId },
        withState: true,
        limit: 10,
      },
    );
    expect(page.messages.map((message) => message.ref.id)).toEqual([
      sent[0].id,
    ]);

    const response = await authFetch("/jmap/api", {
      method: "POST",
      apiKey,
      body: JSON.stringify({
        using: [CORE_CAPABILITY, MAIL_CAPABILITY],
        methodCalls: [
          [
            "Email/query",
            {
              accountId: userId,
              filter: { inMailbox: `sys:${INBOX}:sent` },
            },
            "q1",
          ],
        ],
      }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      methodResponses: [string, { ids: string[] }, string][];
    };
    expect(result.methodResponses[0][1].ids).toEqual([`sent:${sent[0].id}`]);
  });
});
