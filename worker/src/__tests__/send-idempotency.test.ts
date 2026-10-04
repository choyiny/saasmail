// docs/archive/SPEC-send-idempotency.md §2: the service.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  IDEMPOTENCY_PRUNE_BATCH,
  IDEMPOTENCY_STALE_SECONDS,
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyInProgressError,
  IdempotencyReusedError,
  type IdempotentResponse,
  idempotencyKeyOf,
  notifySendAccepted,
  pruneSendIdempotency,
  sendFingerprint,
  withIdempotency,
} from "../lib/send-idempotency";
import { applyMigrations, cleanDb, getDb } from "./helpers";

const NOW = 2_000_000_000;
const USER = "u-1";

function file(name: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    filename: name,
    contentType: "text/plain",
    bytes,
    size: bytes.byteLength,
  };
}

async function rows() {
  return getDb().all<{
    user_id: string;
    key: string;
    status: string;
    response_status: number | null;
    created_at: number;
  }>(sql`SELECT * FROM send_idempotency ORDER BY created_at`);
}

describe("idempotencyKeyOf", () => {
  it("prefers the header, accepts printable ASCII, and allows no key", () => {
    expect(idempotencyKeyOf("header-key", "payload-key")).toEqual({
      key: "header-key",
      error: null,
    });
    expect(idempotencyKeyOf(null, "payload-key").key).toBe("payload-key");
    expect(idempotencyKeyOf(undefined, undefined)).toEqual({
      key: null,
      error: null,
    });
    expect(idempotencyKeyOf("9f1c0d2e-UUID_v4.~!", null).key).toBe(
      "9f1c0d2e-UUID_v4.~!",
    );
  });

  it("rejects spaces, controls, non-ASCII, empty and over-long keys", () => {
    for (const bad of ["has space", "tab\tkey", "clé", "", "k".repeat(256)]) {
      const result = idempotencyKeyOf(bad, null);
      expect(result.key, bad).toBeNull();
      expect(result.error, bad).toMatch(/printable ASCII/);
    }
    expect(idempotencyKeyOf(null, 42).error).toMatch(/printable ASCII/);
  });
});

describe("sendFingerprint", () => {
  it("ignores key order and undefined fields", async () => {
    expect(
      await sendFingerprint({ to: "a@x.com", subject: "Hi", cc: undefined }),
    ).toBe(await sendFingerprint({ subject: "Hi", to: "a@x.com" }));
  });

  it("changes with any field, nested values, and attachment content", async () => {
    const base = await sendFingerprint(
      { kind: "send", to: "a@x.com", variables: { items: [{ n: 1 }] } },
      [file("a.txt", "one")],
    );
    for (const other of [
      sendFingerprint(
        { kind: "reply", to: "a@x.com", variables: { items: [{ n: 1 }] } },
        [file("a.txt", "one")],
      ),
      sendFingerprint(
        { kind: "send", to: "a@x.com", variables: { items: [{ n: 2 }] } },
        [file("a.txt", "one")],
      ),
      sendFingerprint(
        { kind: "send", to: "a@x.com", variables: { items: [{ n: 1 }] } },
        [file("a.txt", "two")],
      ),
      sendFingerprint({
        kind: "send",
        to: "a@x.com",
        variables: { items: [{ n: 1 }] },
      }),
    ]) {
      expect(await other).not.toBe(base);
    }
  });
});

describe("withIdempotency", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  const claim = (fingerprint = "fp-1", now = NOW) => ({
    userId: USER,
    key: "key-1",
    fingerprint,
    now,
  });

  it("runs once, then replays the stored answer", async () => {
    let runs = 0;
    const send = async () => {
      runs += 1;
      return {
        status: 201,
        body: { id: "sent-1", n: runs },
        sentEmailId: "sent-1",
      };
    };

    const first = await withIdempotency(getDb(), claim(), send);
    expect(first).toEqual({
      status: 201,
      body: { id: "sent-1", n: 1 },
      sentEmailId: "sent-1",
      replayed: false,
    });

    const again = await withIdempotency(getDb(), claim("fp-1", NOW + 60), send);
    expect(again).toEqual({
      status: 201,
      body: { id: "sent-1", n: 1 },
      sentEmailId: "sent-1",
      replayed: true,
    });
    expect(runs).toBe(1);
    expect((await rows())[0]).toMatchObject({
      status: "completed",
      response_status: 201,
    });
  });

  it("refuses the same key for a different request", async () => {
    await withIdempotency(getDb(), claim("fp-1"), async () => ({
      status: 201,
      body: {},
    }));
    await expect(
      withIdempotency(getDb(), claim("fp-2", NOW + 1), async () => ({
        status: 201,
        body: {},
      })),
    ).rejects.toBeInstanceOf(IdempotencyReusedError);
  });

  it("refuses a retry while the first request is still running", async () => {
    let finish: () => void = () => {};
    const first = withIdempotency(
      getDb(),
      claim(),
      () =>
        new Promise<IdempotentResponse>((resolve) => {
          finish = () => resolve({ status: 201, body: { id: "a" } });
        }),
    );
    // Let the first claim land.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      withIdempotency(getDb(), claim("fp-1", NOW + 1), async () => ({
        status: 201,
        body: { id: "b" },
      })),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);

    finish();
    expect((await first).body).toEqual({ id: "a" });
  });

  it("lets any request take over a claim abandoned for 5 minutes", async () => {
    await getDb().run(sql`
      INSERT INTO send_idempotency (user_id, key, fingerprint, status, created_at)
      VALUES (${USER}, 'key-1', 'fp-1', 'pending', ${NOW})
    `);
    // Not yet stale: any request, the same or another, waits.
    for (const fingerprint of ["fp-1", "fp-2"]) {
      await expect(
        withIdempotency(
          getDb(),
          claim(fingerprint, NOW + IDEMPOTENCY_STALE_SECONDS - 1),
          async () => ({ status: 201, body: {} }),
        ),
      ).rejects.toBeInstanceOf(IdempotencyInProgressError);
    }
    // Stale: it never reached the provider (an accepted send is never
    // pending), so nothing was sent and the key is free again.
    const taken = await withIdempotency(
      getDb(),
      claim("fp-2", NOW + IDEMPOTENCY_STALE_SECONDS + 1),
      async () => ({ status: 201, body: { id: "retried" } }),
    );
    expect(taken).toMatchObject({ replayed: false, body: { id: "retried" } });
  });

  it("does not let the original's late answer touch a takeover's claim", async () => {
    let finishOriginal: () => void = () => {};
    const original = withIdempotency(
      getDb(),
      claim("fp-1", NOW),
      () =>
        new Promise<IdempotentResponse>((resolve) => {
          finishOriginal = () =>
            resolve({ status: 201, body: { id: "late" }, sentEmailId: "late" });
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Five minutes later another request takes the key over and completes.
    const takeover = await withIdempotency(
      getDb(),
      claim("fp-2", NOW + IDEMPOTENCY_STALE_SECONDS + 1),
      async () => ({ status: 201, body: { id: "new" }, sentEmailId: "new" }),
    );
    expect(takeover.body).toEqual({ id: "new" });

    // Then the original finishes: its completion matches nothing.
    finishOriginal();
    await original;
    const replay = await withIdempotency(
      getDb(),
      claim("fp-2", NOW + IDEMPOTENCY_STALE_SECONDS + 2),
      async () => ({ status: 201, body: { id: "never" } }),
    );
    expect(replay).toMatchObject({ replayed: true, body: { id: "new" } });
  });

  it("never releases a send the provider accepted, even when its request then fails", async () => {
    await expect(
      withIdempotency(getDb(), claim(), async () => {
        await notifySendAccepted({ sentEmailId: "sent-9", outcome: "sent" });
        throw new Error("D1 hiccup writing sent_emails");
      }),
    ).rejects.toThrow("D1 hiccup");

    let ran = false;
    const retry = await withIdempotency(
      getDb(),
      claim("fp-1", NOW + 30),
      async () => {
        ran = true;
        return { status: 201, body: {} };
      },
    );
    expect(ran).toBe(false);
    expect(retry).toEqual({
      status: 201,
      body: { id: "sent-9", status: "sent", incomplete: true },
      sentEmailId: "sent-9",
      replayed: true,
    });
  });

  it("answers from the acceptance while the request is still finishing", async () => {
    let finish: () => void = () => {};
    const first = withIdempotency(getDb(), claim(), async () => {
      await notifySendAccepted({ sentEmailId: "sent-7", outcome: "retrying" });
      await new Promise<void>((resolve) => (finish = resolve));
      return {
        status: 201,
        body: { id: "sent-7", status: "retrying", full: true },
        sentEmailId: "sent-7",
      };
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Accepted already: a retry is answered, not told to wait.
    const meanwhile = await withIdempotency(
      getDb(),
      claim("fp-1", NOW + 1),
      async () => ({
        status: 201,
        body: {},
      }),
    );
    expect(meanwhile.body).toEqual({
      id: "sent-7",
      status: "retrying",
      incomplete: true,
    });

    // Once it finishes, the full answer replaces the provisional one.
    finish();
    await first;
    const after = await withIdempotency(
      getDb(),
      claim("fp-1", NOW + 2),
      async () => ({
        status: 201,
        body: {},
      }),
    );
    expect(after.body).toEqual({
      id: "sent-7",
      status: "retrying",
      full: true,
    });
  });

  it("ignores an acceptance outside a keyed send", async () => {
    await expect(
      notifySendAccepted({ sentEmailId: "x", outcome: "sent" }),
    ).resolves.toBeUndefined();
    expect(await rows()).toEqual([]);
  });

  it("forgets a key after 24 hours", async () => {
    await withIdempotency(getDb(), claim("fp-1"), async () => ({
      status: 201,
      body: { id: "old" },
    }));
    const later = await withIdempotency(
      getDb(),
      claim("fp-2", NOW + IDEMPOTENCY_TTL_SECONDS + 1),
      async () => ({ status: 201, body: { id: "new" } }),
    );
    expect(later).toMatchObject({ replayed: false, body: { id: "new" } });
  });

  it("releases the key when the request throws or answers with an error", async () => {
    await expect(
      withIdempotency(getDb(), claim(), async () => {
        throw new Error("provider down");
      }),
    ).rejects.toThrow("provider down");
    expect(await rows()).toEqual([]);

    const refused = await withIdempotency(getDb(), claim(), async () => ({
      status: 400,
      body: { error: "Missing required template variables" },
    }));
    expect(refused).toMatchObject({ status: 400, replayed: false });
    expect(await rows()).toEqual([]);

    // So the retry runs.
    const retried = await withIdempotency(getDb(), claim(), async () => ({
      status: 201,
      body: { id: "ok" },
    }));
    expect(retried.replayed).toBe(false);
  });

  it("keeps keys apart per user", async () => {
    await withIdempotency(getDb(), claim("fp-1"), async () => ({
      status: 201,
      body: { who: "u-1" },
    }));
    const other = await withIdempotency(
      getDb(),
      { userId: "u-2", key: "key-1", fingerprint: "fp-2", now: NOW },
      async () => ({ status: 201, body: { who: "u-2" } }),
    );
    expect(other).toMatchObject({ replayed: false, body: { who: "u-2" } });
  });
});

describe("pruneSendIdempotency", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("deletes keys older than 24 hours, in bounded batches", async () => {
    const insert = (prefix: string, count: number, at: number) =>
      getDb().run(sql`
        INSERT INTO send_idempotency (user_id, key, fingerprint, status, created_at)
        WITH RECURSIVE n(i) AS (
          SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}
        )
        SELECT 'u', ${prefix} || i, 'fp', 'completed', ${at} FROM n
      `);
    await insert(
      "old-",
      IDEMPOTENCY_PRUNE_BATCH + 5,
      NOW - IDEMPOTENCY_TTL_SECONDS - 10,
    );
    await insert("new-", 3, NOW - 60);

    expect(await pruneSendIdempotency(getDb(), NOW)).toBe(
      IDEMPOTENCY_PRUNE_BATCH + 5,
    );
    expect((await rows()).map((row) => row.key).sort()).toEqual([
      "new-1",
      "new-2",
      "new-3",
    ]);
  });
});
