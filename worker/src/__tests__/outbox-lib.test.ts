import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { outboxEmails } from "../db/outbox-emails.schema";
import { env } from "cloudflare:workers";
import { sendViaOutbox } from "../lib/outbox";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import { suppressions } from "../db/suppressions.schema";

describe("outbox_emails table", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("round-trips an outbox row", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(outboxEmails).values({
      id: "ob-1",
      sentEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      transactional: 0,
      status: "pending",
      attempts: 1,
      lastError: "quota exceeded",
      nextRetryAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const rows = await db
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.id, "ob-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].sequenceEmailId).toBeNull();
  });
});

/** Fake sender whose result is scripted per call. */
function fakeSender(results: SendEmailResult[]): EmailSender & {
  calls: SendEmailParams[];
} {
  const calls: SendEmailParams[] = [];
  return {
    provider: "none" as const,
    calls,
    async send(params: SendEmailParams) {
      calls.push(params);
      return results[Math.min(calls.length - 1, results.length - 1)];
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
  };
}

const OK: SendEmailResult = { id: "prov-1", error: null };
const TRANSIENT: SendEmailResult = {
  id: null,
  error: { message: "quota exceeded", transient: true },
};
const PERMANENT: SendEmailResult = {
  id: null,
  error: { message: "invalid recipient", transient: false },
};

describe("sendViaOutbox", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  function baseParams(sender: EmailSender) {
    return {
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      sender,
      sentEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      from: "Me <me@saasmail.test>",
      to: "to@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      headers: { "Message-ID": "<mid-1@saasmail.test>" },
      transactional: true,
    };
  }

  it("deletes the outbox row on success", async () => {
    const sender = fakeSender([OK]);
    const result = await sendViaOutbox(baseParams(sender));
    expect(result.outcome).toBe("sent");
    expect(result.send.result?.id).toBe("prov-1");
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(0);
  });

  it("keeps a pending row with attempts=1 on transient failure", async () => {
    const sender = fakeSender([TRANSIENT]);
    const result = await sendViaOutbox(baseParams(sender));
    expect(result.outcome).toBe("retrying");
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lastError).toBe("quota exceeded");
    expect(rows[0].sentEmailId).toBe("se-1");
    expect(rows[0].nextRetryAt).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000),
    );
    expect(JSON.parse(rows[0].headers!)["Message-ID"]).toBe(
      "<mid-1@saasmail.test>",
    );
  });

  it("marks the row failed on permanent failure", async () => {
    const sender = fakeSender([PERMANENT]);
    const result = await sendViaOutbox(baseParams(sender));
    expect(result.outcome).toBe("failed");
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].attempts).toBe(1);
  });

  it("deletes the row when every recipient is suppressed", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(suppressions).values({
      id: "sup-1",
      email: "to@example.com",
      reason: "unsubscribed",
      createdAt: now,
    });
    const sender = fakeSender([OK]);
    const result = await sendViaOutbox({
      ...baseParams(sender),
      transactional: false, // suppression only applies to marketing sends
    });
    expect(result.outcome).toBe("suppressed");
    expect(sender.calls).toHaveLength(0);
    const rows = await db.select().from(outboxEmails);
    expect(rows).toHaveLength(0);
  });
});
