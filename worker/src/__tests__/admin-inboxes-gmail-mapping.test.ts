import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { senderIdentities } from "../db/sender-identities.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { eq } from "drizzle-orm";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

describe("admin inboxes router — Gmail mapping", () => {
  it("PATCH persists source and gmailAccountId into sender_identities", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({
          source: "gmail",
          gmailAccountId: "acct-1",
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      gmailAccountId: string | null;
    };
    expect(body.source).toBe("gmail");
    expect(body.gmailAccountId).toBe("acct-1");

    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows[0].source).toBe("gmail");
    expect(rows[0].gmailAccountId).toBe("acct-1");
  });

  it("GET list returns source and gmailAccountId for a mapped inbox", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await authFetch(`/api/admin/inboxes/${encodeURIComponent("a@x.com")}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ source: "gmail", gmailAccountId: "acct-1" }),
    });

    const list = await authFetch("/api/admin/inboxes", { apiKey });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Array<{
      email: string;
      source: string;
      gmailAccountId: string | null;
    }>;
    const row = rows.find((r) => r.email === "a@x.com");
    expect(row?.source).toBe("gmail");
    expect(row?.gmailAccountId).toBe("acct-1");
  });

  it("a partial update that omits source/gmailAccountId leaves them unchanged", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await authFetch(`/api/admin/inboxes/${encodeURIComponent("a@x.com")}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ source: "gmail", gmailAccountId: "acct-1" }),
    });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: "Renamed" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      gmailAccountId: string | null;
    };
    expect(body.source).toBe("gmail");
    expect(body.gmailAccountId).toBe("acct-1");

    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows[0].source).toBe("gmail");
    expect(rows[0].gmailAccountId).toBe("acct-1");
  });

  it("clears gmailAccountId when a body names only source cloudflare", async () => {
    // "Unmapped" has to mean unmapped to the cron too. Leaving the id behind
    // kept the inbox receiving through Google while replies left through the
    // configured provider.
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: "Keep me",
      source: "gmail",
      gmailAccountId: "acct-1",
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ source: "cloudflare" }),
      },
    );

    expect(res.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows[0].source).toBe("cloudflare");
    expect(rows[0].gmailAccountId).toBeNull();
    // Unmapping is not a reset of the rest of the row.
    expect(rows[0].displayName).toBe("Keep me");
  });

  it("rejects a body that asks for cloudflare and a mailbox at once", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({
          source: "cloudflare",
          gmailAccountId: "acct-1",
        }),
      },
    );

    expect(res.status).toBe(400);
    // Refused before anything was written.
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows).toHaveLength(0);
  });

  it("forgets the old mailbox's Gmail thread ids when an inbox is re-pointed", async () => {
    // Gmail thread ids are per-mailbox and nothing records which account
    // issued one. Left behind, the next reply on any pre-remap thread hands
    // the OLD account's id to the NEW account's messages.send: 4xx, terminal,
    // never queued — so every historical thread 502s forever while the UI
    // says to send it again, and the only exit is a manual D1 UPDATE.
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      source: "gmail",
      gmailAccountId: "acct-1",
      createdAt: now,
      updatedAt: now,
    });

    const person = await createTestPerson({ id: "p-1", email: "c@ex.com" });
    await createTestEmail({
      id: "rcv-old",
      personId: person.id,
      recipient: "a@x.com",
      subject: "Before the remap",
      messageId: "old@ex.com",
    });
    await getDb()
      .update(emails)
      .set({ gmailMessageId: "m-old", gmailThreadId: "th-acct-1" })
      .where(eq(emails.id, "rcv-old"));
    await getDb().insert(sentEmails).values({
      id: "snt-old",
      personId: person.id,
      fromAddress: "a@x.com",
      toAddress: "c@ex.com",
      subject: "Re: Before the remap",
      status: "sent",
      gmailMessageId: "m-old-sent",
      gmailThreadId: "th-acct-1",
      sentAt: now,
      createdAt: now,
    });
    // A row on a DIFFERENT inbox, whose mapping this PATCH does not touch.
    await createTestEmail({
      id: "rcv-other",
      personId: person.id,
      recipient: "b@x.com",
      subject: "Another inbox",
      messageId: "other@ex.com",
    });
    await getDb()
      .update(emails)
      .set({ gmailThreadId: "th-elsewhere" })
      .where(eq(emails.id, "rcv-other"));

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ source: "gmail", gmailAccountId: "acct-2" }),
      },
    );
    expect(res.status).toBe(200);
    const mapping = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(mapping[0].gmailAccountId).toBe("acct-2");

    const [received] = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.id, "rcv-old"));
    expect(received.gmailThreadId).toBeNull();
    const [sent] = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "snt-old"));
    expect(sent.gmailThreadId).toBeNull();
    // Only this inbox's threads are forgotten.
    const [untouched] = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.id, "rcv-other"));
    expect(untouched.gmailThreadId).toBe("th-elsewhere");
  });

  it("leaves the stored threads alone when the mapping did not change", async () => {
    // Renaming an inbox must not cost it its Gmail threading.
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      source: "gmail",
      gmailAccountId: "acct-1",
      createdAt: now,
      updatedAt: now,
    });
    const person = await createTestPerson({ id: "p-2", email: "d@ex.com" });
    await createTestEmail({
      id: "rcv-keep",
      personId: person.id,
      recipient: "a@x.com",
      subject: "Keep me threaded",
      messageId: "keep@ex.com",
    });
    await getDb()
      .update(emails)
      .set({ gmailThreadId: "th-acct-1" })
      .where(eq(emails.id, "rcv-keep"));

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: "Renamed" }),
      },
    );
    expect(res.status).toBe(200);

    const [row] = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.id, "rcv-keep"));
    expect(row.gmailThreadId).toBe("th-acct-1");
  });

  it("rejects a non-null gmailGroupAddress with 400 and leaves the row untouched", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    // Pre-existing row with distinct source/gmailAccountId, so a half-apply
    // would be detectable.
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: "Original",
      source: "cloudflare",
      gmailAccountId: null,
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({
          source: "gmail",
          gmailAccountId: "acct-1",
          gmailGroupAddress: "group@example.com",
        }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/group/i);
    expect(body.error).toMatch(/not supported/i);

    // Nothing from the same request applied — not even the other fields.
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe("Original");
    expect(rows[0].source).toBe("cloudflare");
    expect(rows[0].gmailAccountId).toBeNull();
  });

  it("PATCH rejects a source value outside the enum with 400", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ source: "outlook" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 for a non-admin caller", async () => {
    const { apiKey } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ source: "gmail" }),
      },
    );
    expect(res.status).toBe(403);
  });
});
