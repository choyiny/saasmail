import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiKeys } from "../db/api-keys.schema";
import { users } from "../db/auth.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";
import {
  KEEPALIVE_COMMENT,
  PUSH_TYPES,
  RETRY_PREAMBLE,
  openEventSource,
  parseEventSourceParams,
  runPushLoop,
  type PushLoop,
} from "../jmap/event-source";
import { jmapStateIssuedAt } from "../jmap/state";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { acct } from "./jmap-ids";

const MINE = "mine@saasmail.test";

// One hour into the current UTC day: every state the stream builds over its
// five minutes has the same issuedAt as a state the API returns right now.
const START_MS =
  (jmapStateIssuedAt(Math.floor(Date.now() / 1000)) + 3600) * 1000;

async function addIdentity(email: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email, displayName: "Inbox", createdAt: now, updatedAt: now });
}

async function member(id: string) {
  const { userId, apiKey } = await createTestUser({
    id,
    role: "member",
    email: `${id}@example.com`,
  });
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email: MINE,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
  return { userId, apiKey };
}

async function emailState(apiKey: string, userId: string): Promise<string> {
  const response = await authFetch("/jmap/api", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      using: [CORE_CAPABILITY, MAIL_CAPABILITY],
      methodCalls: [["Email/get", { accountId: acct(userId), ids: [] }, "g"]],
    }),
  });
  const body = (await response.json()) as {
    methodResponses: [string, Record<string, any>, string][];
  };
  return body.methodResponses[0][1].state as string;
}

let emailCount = 0;
async function newEmail() {
  emailCount += 1;
  await createTestEmail({
    id: `push-email-${emailCount}`,
    personId: "push-person",
    recipient: MINE,
    messageId: `push-email-${emailCount}@example.com`,
  });
}

type ParsedEvent = { event: string | null; data: any; comment: string | null };

function parseEvents(text: string): ParsedEvent[] {
  return text
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const parsed: ParsedEvent = { event: null, data: null, comment: null };
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) parsed.event = line.slice(7);
        else if (line.startsWith("data: "))
          parsed.data = JSON.parse(line.slice(6));
        else if (line.startsWith(": ")) parsed.comment = line.slice(2);
        else if (line.startsWith("retry: ")) parsed.event = "retry";
      }
      return parsed;
    });
}

/** Wait for real time to pass without a foreground shell sleep: macrotask turns. */
function turn() {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * Opens a stream through the real handler (auth, D1, re-checks) with a fake
 * clock: `tick()` releases one 10 s sleep and waits until the loop sleeps
 * again or the stream closes.
 */
async function openStream(
  apiKey: string | null,
  query: string,
  queryBudget?: number,
) {
  let nowMs = START_MS;
  const sleepers: (() => void)[] = [];
  const headers: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};
  const response = await openEventSource(
    new Request(`http://localhost/jmap/eventsource/${query}`, { headers }),
    env as unknown as CloudflareBindings,
    {
      queryBudget,
      now: () => nowMs,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          sleepers.push(() => {
            nowMs += ms;
            resolve();
          });
        }),
    },
  );

  let text = "";
  let closed = false;
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          return;
        }
        text += decoder.decode(value, { stream: true });
      }
    })();
  }

  const idle = async () => {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      if (sleepers.length > 0 || closed) {
        // Let the reader drain what was written before the loop slept.
        for (let drain = 0; drain < 5; drain += 1) await turn();
        return;
      }
      await turn();
    }
    throw new Error("the stream neither slept nor closed");
  };

  return {
    response,
    idle,
    async tick(count = 1) {
      for (let index = 0; index < count; index += 1) {
        await idle();
        if (closed) return;
        sleepers.shift()!();
      }
      await idle();
    },
    events: () => parseEvents(text),
    stateEvents: () =>
      parseEvents(text).filter((event) => event.event === "state"),
    text: () => text,
    closed: () => closed,
    elapsedMs: () => nowMs - START_MS,
    cancel: () => reader?.cancel(),
  };
}

describe("JMAP EventSource push", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: "push-person", email: "push@example.com" });
  });

  it("sends retry, then an initial state event for the requested types", async () => {
    const { userId, apiKey } = await createTestUser({ id: "push-initial" });
    await addIdentity(MINE);
    const stream = await openStream(
      apiKey,
      "?types=Email,Mailbox,Bogus&closeafter=no&ping=0",
    );
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(stream.response.headers.get("Cache-Control")).toBe(
      "no-cache, no-transform",
    );
    await stream.idle();

    expect(stream.text().startsWith(RETRY_PREAMBLE)).toBe(true);
    const state = await emailState(apiKey, userId);
    expect(stream.stateEvents()).toEqual([
      {
        event: "state",
        comment: null,
        data: {
          "@type": "StateChange",
          changed: { [acct(userId)]: { Email: state, Mailbox: state } },
        },
      },
    ]);
    // One line of JSON per event: go-jmap reads a single data line.
    for (const block of stream.text().split("\n\n")) {
      expect(
        block.split("\n").filter((line) => line.startsWith("data:")).length,
      ).toBeLessThanOrEqual(1);
    }
    await stream.cancel();
  });

  it("reports a change with exactly one state event naming only the requested types", async () => {
    const { userId, apiKey } = await createTestUser({ id: "push-change" });
    await addIdentity(MINE);
    const stream = await openStream(apiKey, "?types=Email,Thread&ping=0");
    await stream.idle();
    expect(stream.stateEvents()).toHaveLength(1);

    await stream.tick();
    expect(stream.stateEvents()).toHaveLength(1);

    await newEmail();
    await stream.tick();
    const state = await emailState(apiKey, userId);
    const events = stream.stateEvents();
    expect(events).toHaveLength(2);
    expect(events[1].data.changed).toEqual({
      [acct(userId)]: { Email: state, Thread: state },
    });

    await stream.tick(2);
    expect(stream.stateEvents()).toHaveLength(2);
    await stream.cancel();
  });

  it("with closeafter=state, sends no initial event and closes after the first change", async () => {
    const { userId, apiKey } = await createTestUser({ id: "push-close" });
    await addIdentity(MINE);
    const stream = await openStream(apiKey, "?types=*&closeafter=state&ping=0");
    await stream.idle();
    expect(stream.stateEvents()).toEqual([]);

    await stream.tick();
    expect(stream.stateEvents()).toEqual([]);
    expect(stream.closed()).toBe(false);

    await newEmail();
    await stream.tick();
    const state = await emailState(apiKey, userId);
    expect(stream.stateEvents().map((event) => event.data.changed)).toEqual([
      {
        [acct(userId)]: Object.fromEntries(
          PUSH_TYPES.map((type) => [type, state]),
        ),
      },
    ]);
    expect(stream.closed()).toBe(true);
  });

  it("rounds ping=15 up to 20 s and says so in each ping", async () => {
    const { apiKey } = await createTestUser({ id: "push-ping" });
    await addIdentity(MINE);
    const stream = await openStream(apiKey, "?types=Email&ping=15");
    await stream.idle();

    await stream.tick();
    expect(stream.events().filter((event) => event.event === "ping")).toEqual(
      [],
    );
    await stream.tick();
    await stream.tick(2);
    const pings = stream.events().filter((event) => event.event === "ping");
    expect(pings.map((event) => event.data)).toEqual([
      { interval: 20 },
      { interval: 20 },
    ]);
    expect(stream.text()).not.toContain(KEEPALIVE_COMMENT);
    await stream.cancel();
  });

  it("writes a keepalive comment after 30 s without bytes", async () => {
    const { apiKey } = await createTestUser({ id: "push-keepalive" });
    await addIdentity(MINE);
    const stream = await openStream(apiKey, "?types=Email&ping=0");
    await stream.idle();

    await stream.tick(2);
    expect(stream.text()).not.toContain(KEEPALIVE_COMMENT);
    await stream.tick();
    expect(
      stream.events().filter((event) => event.comment === "keepalive"),
    ).toHaveLength(1);
    await stream.cancel();
  });

  it("closes cleanly after five minutes", async () => {
    const { apiKey } = await createTestUser({ id: "push-lifetime" });
    // No known type: pings and keepalives only, no queries after connect.
    const stream = await openStream(apiKey, "?types=Nothing&ping=0");
    await stream.idle();
    expect(stream.stateEvents()).toEqual([]);

    await stream.tick(29);
    expect(stream.closed()).toBe(false);
    await stream.tick();
    expect(stream.closed()).toBe(true);
    expect(stream.elapsedMs()).toBe(5 * 60 * 1000);
  });

  it("closes once the query budget is spent, before five minutes", async () => {
    // A member's seq check is cheap enough that the full 40 can outlast the
    // five minutes; a budget of 25 is spent first.
    const { apiKey } = await member("push-budget");
    const stream = await openStream(apiKey, "?types=Email&ping=0", 25);
    await stream.idle();
    expect(stream.stateEvents()).toHaveLength(1);
    for (let index = 0; index < 30 && !stream.closed(); index += 1) {
      await stream.tick();
    }
    expect(stream.closed()).toBe(true);
    // Connect (auth, state, the initial event's re-check) plus the seq check
    // each tick: well past a minute, well before the five.
    expect(stream.elapsedMs()).toBeGreaterThan(60 * 1000);
    expect(stream.elapsedMs()).toBeLessThan(5 * 60 * 1000);
    expect(stream.stateEvents()).toHaveLength(1);
  });

  it("closes without the state event once the API key is revoked", async () => {
    const { userId, apiKey } = await createTestUser({ id: "push-revoked" });
    await addIdentity(MINE);
    const stream = await openStream(apiKey, "?types=Email&ping=0");
    await stream.idle();
    expect(stream.stateEvents()).toHaveLength(1);

    await getDb().delete(apiKeys).where(eq(apiKeys.userId, userId));
    await newEmail();
    await stream.tick();
    expect(stream.closed()).toBe(true);
    expect(stream.stateEvents()).toHaveLength(1);
  });

  it("closes without the state event once an inbox permission is removed", async () => {
    const { userId, apiKey } = await member("push-unpermitted");
    const stream = await openStream(apiKey, "?types=Email&ping=0");
    await stream.idle();
    expect(stream.stateEvents()).toHaveLength(1);

    await getDb()
      .delete(inboxPermissions)
      .where(eq(inboxPermissions.userId, userId));
    await newEmail();
    await stream.tick();
    expect(stream.closed()).toBe(true);
    expect(stream.stateEvents()).toHaveLength(1);
  });

  it("closes without the state event once an admin is demoted to a member of the same inboxes", async () => {
    const { userId, apiKey } = await createTestUser({ id: "push-demoted" });
    await addIdentity(MINE);
    const stream = await openStream(apiKey, "?types=Email&ping=0");
    await stream.idle();
    expect(stream.stateEvents()).toHaveLength(1);

    // Same inbox set, so the same state fingerprint: only the role changed.
    await getDb()
      .update(users)
      .set({ role: "member" })
      .where(eq(users.id, userId));
    await getDb()
      .insert(inboxPermissions)
      .values({
        userId,
        email: MINE,
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: null,
      });
    await newEmail();
    await stream.tick();
    expect(stream.closed()).toBe(true);
    expect(stream.stateEvents()).toHaveLength(1);
  });

  it("answers 401 without credentials and 400 for bad closeafter or ping", async () => {
    const unauthorized = await authFetch(
      "/jmap/eventsource/?types=*&closeafter=no&ping=0",
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );

    const { apiKey } = await createTestUser({ id: "push-bad-params" });
    for (const query of [
      "?types=*&closeafter=sometimes&ping=0",
      "?types=*&closeafter=no&ping=-1",
      "?types=*&closeafter=no&ping=abc",
      "?types=*&closeafter=no&ping=1.5",
    ]) {
      const response = await authFetch(`/jmap/eventsource/${query}`, {
        apiKey,
      });
      expect(response.status, query).toBe(400);
      expect(response.headers.get("Content-Type")).toContain(
        "application/problem+json",
      );
    }
  });

  it("serves the first event over the route, with or without the slash, and stops on cancel", async () => {
    const { userId, apiKey } = await createTestUser({ id: "push-route" });
    await addIdentity(MINE);
    for (const path of ["/jmap/eventsource/", "/jmap/eventsource"]) {
      const response = await authFetch(
        `${path}?types=Email&closeafter=no&ping=0`,
        { apiKey },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "text/event-stream; charset=utf-8",
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("event: state")) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel();

      expect(text.startsWith(RETRY_PREAMBLE)).toBe(true);
      const state = parseEvents(text).find((event) => event.event === "state");
      expect(state?.data).toEqual({
        "@type": "StateChange",
        changed: {
          [acct(userId)]: { Email: await emailState(apiKey, userId) },
        },
      });
    }
  });
});

describe("EventSource parameters and loop", () => {
  const params = (query: string) =>
    parseEventSourceParams(
      new URL(`http://localhost/jmap/eventsource/${query}`),
    );

  it("parses types, closeafter and ping, clamping ping to [10, 300] in 10 s steps", () => {
    expect(params("").params).toEqual({
      types: [...PUSH_TYPES],
      closeAfterState: false,
      pingSeconds: 0,
    });
    expect(params("?types=Thread,Email,Nope").params?.types).toEqual([
      "Email",
      "Thread",
    ]);
    expect(params("?types=Nope").params?.types).toEqual([]);
    expect(params("?closeafter=state").params?.closeAfterState).toBe(true);
    expect(params("?ping=5").params?.pingSeconds).toBe(10);
    expect(params("?ping=15").params?.pingSeconds).toBe(20);
    expect(params("?ping=30").params?.pingSeconds).toBe(30);
    expect(params("?ping=100000").params?.pingSeconds).toBe(300);
    expect(params("?closeafter=never").error).not.toBeNull();
    expect(params("?ping=-5").error).not.toBeNull();
  });

  function fakeLoop(overrides: Partial<PushLoop> = {}) {
    let now = START_MS;
    const writes: string[] = [];
    const loop: PushLoop = {
      accountId: "acct",
      params: { types: ["Email"], closeAfterState: false, pingSeconds: 0 },
      fingerprint: "0123456789abcdef",
      connectState: "connect-state",
      seqQueryCount: 1,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      checkSeq: async () => 1,
      recheck: async () => true,
      queriesUsed: () => 0,
      write: (chunk) => {
        writes.push(chunk);
        return true;
      },
      cancelled: () => false,
      ...overrides,
    };
    return { loop, writes, elapsed: () => now - START_MS };
  }

  it("stops at the query budget: no seq check may push it past 40", async () => {
    let used = 30;
    let checks = 0;
    const fake = fakeLoop({
      seqQueryCount: 2,
      queriesUsed: () => used,
      checkSeq: async () => {
        checks += 1;
        used += 2;
        return 7;
      },
    });
    await runPushLoop(fake.loop);
    expect(checks).toBe(5);
    expect(used).toBe(40);
    expect(fake.elapsed()).toBe(60_000);
  });

  it("reserves the re-check with the seq check: a change on every tick never takes it past 40", async () => {
    let used = 10;
    let seq = 0;
    let peak = 0;
    const fake = fakeLoop({
      seqQueryCount: 1,
      // Unknown up front: the loop learns it from the initial event's re-check.
      recheckQueryCount: 0,
      queriesUsed: () => used,
      checkSeq: async () => {
        used += 1;
        peak = Math.max(peak, used);
        seq += 1;
        return seq;
      },
      recheck: async () => {
        used += 4;
        peak = Math.max(peak, used);
        return true;
      },
    });
    await runPushLoop(fake.loop);
    expect(peak).toBeLessThanOrEqual(40);
    // 10 at connect + 4 for the initial event, then 5 a tick: 5 ticks fit.
    expect(used).toBe(39);
    expect(fake.elapsed()).toBe(60_000);
  });

  it("closes on a DB error without writing a partial event", async () => {
    let checks = 0;
    const fake = fakeLoop({
      checkSeq: async () => {
        checks += 1;
        throw new Error("D1_ERROR");
      },
    });
    await expect(runPushLoop(fake.loop)).resolves.toBeUndefined();
    expect(checks).toBe(1);
    // The preamble and the initial state event, nothing after.
    expect(fake.writes).toHaveLength(2);
    expect(fake.writes.every((chunk) => chunk.endsWith("\n\n"))).toBe(true);
  });

  it("stops when the client is gone", async () => {
    let writes = 0;
    const fake = fakeLoop({
      write: () => {
        writes += 1;
        return writes < 2;
      },
    });
    await runPushLoop(fake.loop);
    expect(writes).toBe(2);
    expect(fake.elapsed()).toBe(0);
  });
});
