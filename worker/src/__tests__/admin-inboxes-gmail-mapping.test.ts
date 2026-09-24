import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { senderIdentities } from "../db/sender-identities.schema";
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
