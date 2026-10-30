// One message addressed to two saasmail inboxes is stored once per inbox. The
// dedupe used to be global per Message-ID, so the second inbox's copy was
// dropped as a "duplicate" (found live with a JMAP To + Bcc send, 2026-09-28).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { handleEmail } from "../email-handler";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { applyMigrations, cleanDb, getDb } from "./helpers";

function inbound(to: string): ForwardableEmailMessage {
  const raw = new TextEncoder().encode(
    [
      "From: Customer <customer@example.com>",
      "To: support@example.com, sales@example.com",
      "Subject: Both inboxes",
      "Message-ID: <shared-1@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "hello",
    ].join("\r\n"),
  );
  return {
    from: "customer@example.com",
    to,
    raw: new Response(raw).body!,
    rawSize: raw.byteLength,
    headers: new Headers(),
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

async function deliver(to: string) {
  const pending: Promise<unknown>[] = [];
  await handleEmail(
    inbound(to),
    env as unknown as CloudflareBindings,
    {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
  await Promise.allSettled(pending);
}

describe("inbound dedupe", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    const now = Math.floor(Date.now() / 1000);
    for (const email of ["support@example.com", "sales@example.com"]) {
      await getDb()
        .insert(senderIdentities)
        .values({ email, createdAt: now, updatedAt: now });
    }
  });

  it("stores one copy per inbox the message was delivered to", async () => {
    await deliver("support@example.com");
    await deliver("sales@example.com");
    const rows = await getDb()
      .select({ recipient: emails.recipient })
      .from(emails)
      .where(eq(emails.messageId, "<shared-1@example.com>"));
    expect(rows.map((row) => row.recipient).sort()).toEqual([
      "sales@example.com",
      "support@example.com",
    ]);
  });

  it("still drops a redelivery to the same inbox", async () => {
    await deliver("support@example.com");
    await deliver("support@example.com");
    const rows = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.messageId, "<shared-1@example.com>"));
    expect(rows).toHaveLength(1);
  });
});
