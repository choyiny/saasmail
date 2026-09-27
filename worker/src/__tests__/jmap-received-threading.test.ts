// Received mail exposes the In-Reply-To and References it arrived with. Both
// are immutable JMAP properties that used to be null, so the change ships with
// an account reset (JMAP id format v3): clients refetch instead of keeping null.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { sha256 } from "@noble/hashes/sha2.js";
import migrationSql from "../../../migrations/0063_backfill_emails_threading_headers.sql?raw";
import { handleEmail } from "../email-handler";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { recordingSender, runJmap } from "./jmap-harness";
import { acct, rid } from "./jmap-ids";

const INBOX = "support@example.com";

function inbound(headers: string[]): ForwardableEmailMessage {
  const raw = new TextEncoder().encode(
    [
      "From: Customer <customer@example.com>",
      `To: ${INBOX}`,
      "Subject: Re: order",
      "Message-ID: <reply-1@example.com>",
      ...headers,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "hello",
    ].join("\r\n"),
  );
  return {
    from: "customer@example.com",
    to: INBOX,
    raw: new Response(raw).body!,
    rawSize: raw.byteLength,
    headers: new Headers(),
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

async function deliver(headers: string[]) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email: INBOX, createdAt: now, updatedAt: now });
  const pending: Promise<unknown>[] = [];
  await handleEmail(
    inbound(headers),
    env as unknown as CloudflareBindings,
    {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
  await Promise.allSettled(pending);
  const [row] = await getDb()
    .select()
    .from(emails)
    .where(eq(emails.messageId, "<reply-1@example.com>"));
  return row;
}

async function runBackfill() {
  const executable = migrationSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
  await env.DB.prepare(executable).run();
}

describe("received In-Reply-To and References", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("are stored as received, including a folded References header", async () => {
    const row = await deliver([
      "In-Reply-To: <orig-1@saasmail.test>",
      "References: <root-1@example.com>",
      " <orig-1@saasmail.test>",
    ]);
    expect(row.inReplyTo).toBe("<orig-1@saasmail.test>");
    expect(row.referencesHeader?.split(/\s+/)).toEqual([
      "<root-1@example.com>",
      "<orig-1@saasmail.test>",
    ]);
  });

  it("are null for mail that has neither header", async () => {
    const row = await deliver([]);
    expect(row.inReplyTo).toBeNull();
    expect(row.referencesHeader).toBeNull();
  });

  it("are backfilled from raw_headers by migration 0063, and only where missing", async () => {
    await createTestPerson({ id: "p1", email: "c@example.com" });
    await createTestEmail({
      id: "old-reply",
      personId: "p1",
      messageId: "<m1@example.com>",
      rawHeaders: JSON.stringify({
        "in-reply-to": "<a@x.test>",
        references: "<r@x.test> <a@x.test>",
      }),
    });
    await createTestEmail({
      id: "old-plain",
      personId: "p1",
      messageId: "<m2@example.com>",
      rawHeaders: JSON.stringify({ subject: "hi" }),
    });
    await createTestEmail({
      id: "old-broken",
      personId: "p1",
      messageId: "<m3@example.com>",
      rawHeaders: "not json",
    });
    await createTestEmail({
      id: "already-set",
      personId: "p1",
      messageId: "<m4@example.com>",
      rawHeaders: JSON.stringify({ "in-reply-to": "<stale@x.test>" }),
      inReplyTo: "<kept@x.test>",
    });

    await runBackfill();
    await runBackfill();

    const rows = new Map(
      (await getDb().select().from(emails)).map((row) => [row.id, row]),
    );
    expect(rows.get("old-reply")).toMatchObject({
      inReplyTo: "<a@x.test>",
      referencesHeader: "<r@x.test> <a@x.test>",
    });
    expect(rows.get("old-plain")).toMatchObject({
      inReplyTo: null,
      referencesHeader: null,
    });
    expect(rows.get("old-broken")).toMatchObject({
      inReplyTo: null,
      referencesHeader: null,
    });
    expect(rows.get("already-set")?.inReplyTo).toBe("<kept@x.test>");
  });

  it("are the received Email's inReplyTo and references over JMAP", async () => {
    const { userId } = await createTestUser({ id: "threading-user" });
    await createTestPerson({ id: "p1", email: "c@example.com" });
    await createTestEmail({
      id: "reply",
      personId: "p1",
      recipient: "inbox@saasmail.test",
      messageId: "<reply@example.com>",
      inReplyTo: "<orig@saasmail.test>",
      referencesHeader: "<root@example.com>\r\n <orig@saasmail.test>",
    });
    await createTestEmail({
      id: "plain",
      personId: "p1",
      recipient: "inbox@saasmail.test",
      messageId: "<plain@example.com>",
    });
    const { sender } = recordingSender();
    const [response] = await runJmap(
      userId,
      [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [rid("reply"), rid("plain")],
            properties: ["id", "messageId", "inReplyTo", "references"],
          },
          "g",
        ],
      ],
      sender,
    );
    const [reply, plain] = (response[1] as Record<string, any>).list;
    expect(reply).toMatchObject({
      messageId: ["reply@example.com"],
      inReplyTo: ["orig@saasmail.test"],
      references: ["root@example.com", "orig@saasmail.test"],
    });
    expect(plain).toMatchObject({ inReplyTo: null, references: null });
  });
});

describe("the JMAP account reset for it (id format v3)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("advertises a new account id, refuses the v2 one, and issues j3 states", async () => {
    const { userId, apiKey } = await createTestUser({ id: "reset-v3-user" });
    const bytes = sha256(new TextEncoder().encode(`jmap-account-v2:${userId}`));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const v2 = `a${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    expect(acct(userId)).not.toBe(v2);

    const session = await (
      await authFetch("/.well-known/jmap", { apiKey })
    ).json<Record<string, any>>();
    expect(Object.keys(session.accounts)).toEqual([acct(userId)]);

    const { sender } = recordingSender();
    const [old, current] = await runJmap(
      userId,
      [
        ["Mailbox/get", { accountId: v2 }, "old"],
        ["Mailbox/get", { accountId: acct(userId), ids: [] }, "new"],
      ],
      sender,
    );
    expect(old).toEqual(["error", { type: "accountNotFound" }, "old"]);
    expect((current[1] as Record<string, any>).state).toMatch(/^j3-/);
  });
});
