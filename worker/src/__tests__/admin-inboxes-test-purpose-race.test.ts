// docs/inboxes.md, "Test inboxes": an edit that does not name the purpose
// never writes back a purpose it read before another admin changed it.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { senderIdentities } from "../db/sender-identities.schema";

const INBOX = "e2e@saasmail.test";

/** Runs between the PATCH's read of the row and its write, once. */
const between = vi.hoisted(() => ({
  run: null as null | (() => Promise<void>),
}));

vi.mock("../lib/messages/thread-backfill", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../lib/messages/thread-backfill")>();
  return {
    ...original,
    latestThreadBackfills: vi.fn(
      async (...args: Parameters<typeof original.latestThreadBackfills>) => {
        const run = between.run;
        between.run = null;
        if (run) await run();
        return original.latestThreadBackfills(...args);
      },
    ),
  };
});

async function identity() {
  const [row] = await getDb()
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.email, INBOX));
  return row;
}

let apiKey = "";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  apiKey = (await createTestUser({ role: "admin" })).apiKey;
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: INBOX,
    displayMode: "chat",
    purpose: "test",
    testRetentionDays: 7,
    createdAt: now,
    updatedAt: now,
  });
});

describe("PATCH /api/admin/inboxes/{email} — a stale purpose", () => {
  it("keeps the switch another admin turned off while a rename was saved", async () => {
    between.run = async () => {
      await getDb()
        .update(senderIdentities)
        .set({ purpose: "mail", testRetentionDays: null })
        .where(eq(senderIdentities.email, INBOX));
    };
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent(INBOX)}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: "E2E" }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      displayName: "E2E",
      purpose: "mail",
      testRetentionDays: null,
    });
    expect(await identity()).toMatchObject({
      displayName: "E2E",
      purpose: "mail",
      testRetentionDays: null,
    });
  });

  it("keeps a row another admin changed while this request returned it to its defaults", async () => {
    between.run = async () => {
      await getDb()
        .update(senderIdentities)
        .set({ forwardTo: "team@example.com" })
        .where(eq(senderIdentities.email, INBOX));
    };
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent(INBOX)}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ purpose: "mail" }),
      },
    );
    expect(res.status).toBe(200);
    expect(await identity()).toMatchObject({ purpose: "mail" });
  });
});
