import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { attachments } from "../db/attachments.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { suppressions } from "../db/suppressions.schema";
import { sendEmail } from "../lib/send-email";
import { attemptOutboxRow } from "../lib/outbox";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import type { ParsedFile } from "../lib/multipart-send";

const ADMIN = { isAdmin: true } as const;
const OK: SendEmailResult = { id: "prov-1", error: null };
const TRANSIENT: SendEmailResult = {
  id: null,
  error: { message: "quota exceeded", transient: true },
};

function file(name: string, text: string): ParsedFile {
  const bytes = new TextEncoder().encode(text);
  return {
    filename: name,
    contentType: "text/plain",
    bytes,
    size: bytes.byteLength,
  };
}

/** A sender that records, at call time, whether the attachments were staged. */
function probingSender(result: SendEmailResult) {
  const seen: { rows: number; objects: number }[] = [];
  const calls: SendEmailParams[] = [];
  const sender: EmailSender = {
    provider: "none" as const,
    async send(params: SendEmailParams) {
      calls.push(params);
      const rows = await getDb()
        .select()
        .from(attachments)
        .where(eq(attachments.kind, "sent"));
      let objects = 0;
      for (const row of rows) {
        if (await env.R2.get(row.r2Key)) objects += 1;
      }
      seen.push({ rows: rows.length, objects });
      return result;
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
  };
  return { sender, seen, calls };
}

const payload = {
  to: "to@example.com",
  fromAddress: "me@saasmail.test",
  subject: "With file",
  bodyHtml: "<p>see file</p>",
};

describe("sent attachments are staged before the provider call", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("has the rows and R2 objects in place when the provider is called", async () => {
    const probe = probingSender(OK);
    const result = await sendEmail({
      db: getDb(),
      env,
      payload: { ...payload, transactional: true },
      files: [file("order.txt", "bytes")],
      allowed: ADMIN,
      sender: probe.sender,
    });
    expect(result.status).toBe("sent");
    expect(probe.seen).toEqual([{ rows: 1, objects: 1 }]);
    expect(result.attachmentIds).toHaveLength(1);
  });

  it("lets the retry processor resend every attachment byte-for-byte", async () => {
    const first = probingSender(TRANSIENT);
    const result = await sendEmail({
      db: getDb(),
      env,
      payload: { ...payload, transactional: true },
      files: [file("retry.txt", "retry-bytes")],
      allowed: ADMIN,
      sender: first.sender,
    });
    expect(result.status).toBe("retrying");
    const [row] = await getDb()
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, result.id!));
    // Make the row due now.
    await getDb()
      .update(outboxEmails)
      .set({ nextRetryAt: 0 })
      .where(eq(outboxEmails.id, row.id));

    const second = probingSender(OK);
    expect(await attemptOutboxRow(getDb(), env, second.sender, row.id)).toBe(
      "sent",
    );
    const sent = second.calls[0].attachments ?? [];
    expect(sent).toHaveLength(1);
    expect(new TextDecoder().decode(sent[0].content as ArrayBuffer)).toBe(
      "retry-bytes",
    );
  });

  it("discards staged rows and objects when every recipient is suppressed", async () => {
    await getDb().insert(suppressions).values({
      id: "sup-1",
      email: "to@example.com",
      reason: "unsubscribe",
      createdAt: 1,
    });
    const probe = probingSender(OK);
    const result = await sendEmail({
      db: getDb(),
      env,
      payload, // not transactional: suppression applies
      files: [file("suppressed.txt", "x")],
      allowed: ADMIN,
      sender: probe.sender,
    });
    expect(result.status).toBe("suppressed");
    expect(probe.calls).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(attachments)
        .where(eq(attachments.kind, "sent")),
    ).toHaveLength(0);
    const listed = await env.R2.list({ prefix: "attachments/sent/" });
    expect(
      listed.objects.filter((o) => o.key.endsWith("/suppressed.txt")),
    ).toEqual([]);
  });

  it("discards staged rows and objects when the send throws", async () => {
    const throwing: EmailSender = {
      provider: "none" as const,
      async send() {
        throw new Error("provider exploded");
      },
      maxAttachmentBytes: () => 25 * 1024 * 1024,
    };
    await expect(
      sendEmail({
        db: getDb(),
        env,
        payload: { ...payload, transactional: true },
        files: [file("thrown.txt", "x")],
        allowed: ADMIN,
        sender: throwing,
      }),
    ).rejects.toThrow("provider exploded");
    expect(
      await getDb()
        .select()
        .from(attachments)
        .where(eq(attachments.kind, "sent")),
    ).toHaveLength(0);
    const listed = await env.R2.list({ prefix: "attachments/sent/" });
    expect(listed.objects.filter((o) => o.key.endsWith("/thrown.txt"))).toEqual(
      [],
    );
  });

  it("keeps staged attachments when the send throws but its outbox row survives", async () => {
    // A D1 failure after the provider call (here the transient-failure update)
    // leaves the outbox row pending. Its retry must still find the files.
    await env.DB.prepare(
      `CREATE TRIGGER outbox_update_fails BEFORE UPDATE ON outbox_emails
       BEGIN SELECT RAISE(ABORT, 'd1 down'); END`,
    ).run();
    try {
      await expect(
        sendEmail({
          db: getDb(),
          env,
          payload: { ...payload, transactional: true },
          files: [file("kept.txt", "kept-bytes")],
          allowed: ADMIN,
          sender: probingSender(TRANSIENT).sender,
        }),
      ).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER outbox_update_fails").run();
    }

    const [row] = await getDb().select().from(outboxEmails);
    expect(row.status).toBe("pending");
    await getDb()
      .update(outboxEmails)
      .set({ nextRetryAt: 0 })
      .where(eq(outboxEmails.id, row.id));
    const retry = probingSender(OK);
    expect(await attemptOutboxRow(getDb(), env, retry.sender, row.id)).toBe(
      "sent",
    );
    const sent = retry.calls[0].attachments ?? [];
    expect(sent).toHaveLength(1);
    expect(new TextDecoder().decode(sent[0].content as ArrayBuffer)).toBe(
      "kept-bytes",
    );
  });
});
