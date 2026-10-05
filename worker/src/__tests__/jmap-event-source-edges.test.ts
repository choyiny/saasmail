// Edge cases of the EventSource push stream (RFC 8620 §7.3) that the main
// suite leaves open: what a real disconnect does to the loop, the D1 query
// count in the worst case (a change on every tick) for each kind of caller,
// a change racing the initial event, and how pings and keepalives interleave.
import { env, exports } from "cloudflare:workers";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { passkeys, sessions } from "../db/auth.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  PUSH_QUERY_BUDGET,
} from "../jmap/constants";
import {
  KEEPALIVE_COMMENT,
  RETRY_PREAMBLE,
  formatPingEvent,
  openEventSource,
  runPushLoop,
  type PushLoop,
} from "../jmap/event-source";
import { formatJmapState, jmapStateIssuedAt } from "../jmap/state";
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

// One hour into the current UTC day, so no state crosses a day bucket.
const START_MS =
  (jmapStateIssuedAt(Math.floor(Date.now() / 1000)) + 3600) * 1000;

/**
 * env.DB with every statement counted (what D1 bills against the invocation)
 * and an optional hook awaited right before a statement runs.
 */
function instrumentedD1(hook?: (query: string) => Promise<void>): {
  db: D1Database;
  count: () => number;
  queries: string[];
} {
  const real = env.DB;
  const queries: string[] = [];
  const wrap = (statement: any, query: string): any =>
    new Proxy(statement, {
      get(target, prop) {
        const value = target[prop];
        if (prop === "bind") {
          return (...args: unknown[]) => wrap(value.apply(target, args), query);
        }
        if (["all", "raw", "first", "run"].includes(prop as string)) {
          return async (...args: unknown[]) => {
            if (hook) await hook(query);
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          queries.push(query);
          return wrap(target.prepare(query), query);
        };
      }
      if (prop === "exec") {
        return (query: string) => {
          queries.push(query);
          return target.exec(query);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, count: () => queries.length, queries };
}

let emailCount = 0;
async function newEmail(recipient = MINE) {
  emailCount += 1;
  await createTestEmail({
    id: `edge-email-${emailCount}`,
    personId: "edge-person",
    recipient,
    messageId: `edge-email-${emailCount}@example.com`,
  });
}

async function addIdentity(email: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email, displayName: "Inbox", createdAt: now, updatedAt: now });
}

async function grant(userId: string, inboxes: string[]) {
  const now = Math.floor(Date.now() / 1000);
  for (let start = 0; start < inboxes.length; start += 10) {
    await getDb()
      .insert(inboxPermissions)
      .values(
        inboxes.slice(start, start + 10).map((email) => ({
          userId,
          email,
          createdAt: now,
          createdBy: null,
        })),
      );
  }
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

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

/**
 * Runs a whole stream to its end with a fake clock and a sleep that makes a
 * new Email land before every tick: the worst case for the query budget,
 * because each tick then pays the seq check and a full re-check.
 */
async function runWithChangeEveryTick(
  request: Request,
  streamEnv: CloudflareBindings,
  recipient: string,
) {
  let nowMs = START_MS;
  let done: Promise<unknown> | null = null;
  const response = await openEventSource(request, streamEnv, {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
      await newEmail(recipient);
    },
    waitUntil: (promise) => {
      done = promise;
    },
  });
  expect(response.status).toBe(200);
  const text = await readAll(response);
  await done;
  return { text, elapsedMs: nowMs - START_MS };
}

describe("EventSource push: disconnects, races and the query budget", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: "edge-person", email: "edge@example.com" });
  });

  it("a client that disconnects mid-sleep ends the loop at once, with no further D1 query", async () => {
    const { apiKey } = await createTestUser({ id: "edge-cancel" });
    await addIdentity(MINE);
    const counted = instrumentedD1();
    let done: Promise<unknown> | null = null;
    // The real timer sleep: only cancel() can wake it before 10 s.
    const response = await openEventSource(
      new Request("http://localhost/jmap/eventsource/?types=Email&ping=0", {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      { ...env, DB: counted.db } as unknown as CloudflareBindings,
      {
        waitUntil: (promise) => {
          done = promise;
        },
      },
    );
    const reader = response.body!.getReader();
    const text = await readUntil(reader, "event: state");
    expect(text).toContain("event: state");
    const queriesAtCancel = counted.count();

    await reader.cancel();
    const outcome = await Promise.race([
      done!.then(() => "done" as const),
      delay(3000),
    ]);
    expect(outcome).toBe("done");
    await delay(20);
    expect(counted.count()).toBe(queriesAtCancel);
  });

  it("over the real route, a disconnect stops the per-tick seq queries", async () => {
    const { apiKey } = await createTestUser({ id: "edge-route-cancel" });
    await addIdentity(MINE);
    const realDb = env.DB;
    const counted = instrumentedD1();
    (env as any).DB = counted.db;
    try {
      const response = await exports.default.fetch(
        "http://localhost/jmap/eventsource/?types=Email&closeafter=no&ping=0",
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await readUntil(reader, "event: state");
      await reader.cancel();
      const afterCancel = counted.count();
      // Past the first 10 s tick: a loop that missed the disconnect would
      // have queried jmap_changes by now.
      await delay(10_800);
      const later = counted.queries.slice(afterCancel);
      expect(later.filter((query) => query.includes("jmap_changes"))).toEqual(
        [],
      );
    } finally {
      (env as any).DB = realDb;
    }
  }, 20_000);

  it("a change landing between connect and the initial event is reported on the next tick", async () => {
    const { userId, apiKey } = await createTestUser({ id: "edge-race" });
    await addIdentity(MINE);
    let apiKeyLookups = 0;
    let injected = false;
    // The second api_keys lookup is the re-check before the initial event:
    // the connect state is already computed by then.
    const counted = instrumentedD1(async (query) => {
      if (!/api_keys/.test(query)) return;
      apiKeyLookups += 1;
      if (apiKeyLookups === 2 && !injected) {
        injected = true;
        await newEmail();
      }
    });
    const before = await emailState(apiKey, userId);

    let nowMs = START_MS;
    const sleepers: (() => void)[] = [];
    const response = await openEventSource(
      new Request("http://localhost/jmap/eventsource/?types=Email&ping=0", {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      { ...env, DB: counted.db } as unknown as CloudflareBindings,
      {
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
    const reader = response.body!.getReader();
    let text = await readUntil(reader, "event: state");
    expect(injected).toBe(true);
    const initial = parseEvents(text).filter((e) => e.event === "state");
    expect(initial).toHaveLength(1);
    // The initial event carries the connect state, from before the write.
    expect(initial[0].data.changed[acct(userId)].Email).toBe(before);

    // Release one tick and read the next state event.
    for (let attempt = 0; attempt < 500 && sleepers.length === 0; attempt += 1)
      await delay(1);
    sleepers.shift()!();
    text += await readUntil(reader, "event: state");
    const events = parseEvents(text).filter((e) => e.event === "state");
    expect(events).toHaveLength(2);
    const after = await emailState(apiKey, userId);
    expect(after).not.toBe(before);
    expect(events[1].data.changed[acct(userId)].Email).toBe(after);
    await reader.cancel();
  });

  it("with only unknown types, it runs its five minutes with no D1 query after connect", async () => {
    const { apiKey } = await createTestUser({ id: "edge-no-types" });
    await addIdentity(MINE);
    const counted = instrumentedD1();
    let nowMs = START_MS;
    let queriesAfterConnect = -1;
    const response = await openEventSource(
      new Request(
        "http://localhost/jmap/eventsource/?types=Bogus,Nope&closeafter=state&ping=0",
        { headers: { Authorization: `Bearer ${apiKey}` } },
      ),
      { ...env, DB: counted.db } as unknown as CloudflareBindings,
      {
        now: () => nowMs,
        sleep: async (ms) => {
          if (queriesAfterConnect < 0) queriesAfterConnect = counted.count();
          nowMs += ms;
          // Changes keep landing; nobody asked about them.
          await newEmail();
        },
      },
    );
    const text = await readAll(response);
    expect(nowMs - START_MS).toBe(5 * 60 * 1000);
    expect(counted.count()).toBe(queriesAfterConnect);
    const events = parseEvents(text);
    expect(events.filter((e) => e.event === "state")).toEqual([]);
    // Nine keepalives: every 30 s until the stream closes at 300 s.
    expect(events.filter((e) => e.comment === "keepalive")).toHaveLength(9);
  });

  it("stays within its 40-query budget with a change on every tick: admin API key", async () => {
    const { apiKey } = await createTestUser({ id: "edge-budget-admin" });
    await addIdentity(MINE);
    await addIdentity("second@saasmail.test");
    const counted = instrumentedD1();
    const { text, elapsedMs } = await runWithChangeEveryTick(
      new Request("http://localhost/jmap/eventsource/?types=*&ping=0", {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      { ...env, DB: counted.db } as unknown as CloudflareBindings,
      MINE,
    );
    expect(counted.count()).toBeLessThanOrEqual(PUSH_QUERY_BUDGET);
    // The budget, not the lifetime, closed it.
    expect(elapsedMs).toBeLessThan(5 * 60 * 1000);
    expect(
      parseEvents(text).filter((e) => e.event === "state").length,
    ).toBeGreaterThan(2);
  });

  it("stays within its 40-query budget with a change on every tick: member with 85 inboxes (one seq query a tick)", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "edge-budget-member",
      role: "member",
      email: "edge-member@example.com",
    });
    const inboxes = Array.from(
      { length: 85 },
      (_, index) => `box${String(index).padStart(2, "0")}@saasmail.test`,
    );
    await grant(userId, inboxes);
    const counted = instrumentedD1();
    const { text, elapsedMs } = await runWithChangeEveryTick(
      new Request("http://localhost/jmap/eventsource/?types=*&ping=0", {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      { ...env, DB: counted.db } as unknown as CloudflareBindings,
      inboxes[84],
    );
    expect(counted.count()).toBeLessThanOrEqual(PUSH_QUERY_BUDGET);
    expect(elapsedMs).toBeLessThan(5 * 60 * 1000);
    expect(
      parseEvents(text).filter((e) => e.event === "state").length,
    ).toBeGreaterThan(1);
  });

  it("stays within its 40-query budget with a change on every tick: member on a session cookie with the passkey gate on", async () => {
    const { userId } = await createTestUser({
      id: "edge-budget-cookie",
      role: "member",
      email: "edge-cookie@example.com",
    });
    const inboxes = Array.from(
      { length: 45 },
      (_, index) => `cbox${String(index).padStart(2, "0")}@saasmail.test`,
    );
    await grant(userId, inboxes);
    const now = new Date();
    const token = "edge-cookie-session-token";
    await getDb()
      .insert(sessions)
      .values({
        id: "edge-cookie-session",
        token,
        userId,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      });
    await getDb().insert(passkeys).values({
      id: "edge-cookie-passkey",
      publicKey: "pk",
      userId,
      credentialID: "edge-cookie-cred",
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });
    const signature = await makeSignature(
      token,
      (env as any).BETTER_AUTH_SECRET as string,
    );
    const counted = instrumentedD1();
    const { text, elapsedMs } = await runWithChangeEveryTick(
      new Request("http://localhost/jmap/eventsource/?types=*&ping=0", {
        headers: { Cookie: `saasmail.session_token=${token}.${signature}` },
      }),
      {
        ...env,
        DB: counted.db,
        DISABLE_PASSKEY_GATE: "false",
      } as unknown as CloudflareBindings,
      inboxes[0],
    );
    // The cookie authenticated (an initial state event went out) ...
    expect(
      parseEvents(text).filter((e) => e.event === "state").length,
    ).toBeGreaterThan(1);
    // ... and the most expensive re-check still keeps the stream within 40.
    expect(counted.count()).toBeLessThanOrEqual(PUSH_QUERY_BUDGET);
    expect(elapsedMs).toBeLessThan(5 * 60 * 1000);
  });
});

describe("EventSource loop: pings, keepalives and failures", () => {
  type Write = { atSeconds: number; chunk: string };
  const FP = "0123456789abcdef";

  /** A loop with a fake clock; `onTick(n)` runs inside the n-th sleep. */
  function fakeLoop(
    overrides: Partial<PushLoop> = {},
    onTick: (tick: number) => void = () => {},
  ) {
    let now = START_MS;
    let ticks = 0;
    const writes: Write[] = [];
    const loop: PushLoop = {
      accountId: "acct",
      params: { types: ["Email"], closeAfterState: false, pingSeconds: 0 },
      fingerprint: FP,
      // What the loop itself builds for seq 0, so an unchanged seq is quiet.
      connectState: formatJmapState(
        0,
        jmapStateIssuedAt(Math.floor(START_MS / 1000)),
        FP,
      ),
      seqQueryCount: 0,
      sleep: async (ms) => {
        ticks += 1;
        onTick(ticks);
        now += ms;
      },
      now: () => now,
      checkSeq: async () => 0,
      recheck: async () => true,
      queriesUsed: () => 0,
      write: (chunk) => {
        writes.push({ atSeconds: (now - START_MS) / 1000, chunk });
        return true;
      },
      cancelled: () => false,
      ...overrides,
    };
    return { loop, writes };
  }

  const at = (writes: Write[], chunk: string) =>
    writes.filter((w) => w.chunk === chunk).map((w) => w.atSeconds);

  it("interleaves a 60 s ping with keepalives: never 30 s of silence, never both in one tick", async () => {
    const fake = fakeLoop({
      params: { types: [], closeAfterState: false, pingSeconds: 60 },
    });
    await runPushLoop(fake.loop);
    expect(at(fake.writes, formatPingEvent(60))).toEqual([60, 120, 180, 240]);
    expect(at(fake.writes, KEEPALIVE_COMMENT)).toEqual([30, 90, 150, 210, 270]);
    const times = fake.writes.map((w) => w.atSeconds);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index] - times[index - 1]).toBeLessThanOrEqual(30);
    }
  });

  it("a state event resets the keepalive clock but not the ping schedule", async () => {
    let seq = 0;
    const fake = fakeLoop(
      {
        params: { types: ["Email"], closeAfterState: false, pingSeconds: 60 },
        checkSeq: async () => seq,
      },
      (tick) => {
        if (tick === 2) seq = 1; // seen by the check at t = 20
      },
    );
    await runPushLoop(fake.loop);
    const states = fake.writes.filter((w) =>
      w.chunk.startsWith("event: state"),
    );
    expect(states.map((w) => w.atSeconds)).toEqual([0, 20]);
    expect(at(fake.writes, KEEPALIVE_COMMENT)[0]).toBe(50);
    expect(at(fake.writes, formatPingEvent(60))).toEqual([60, 120, 180, 240]);
  });

  it("a re-check that throws ends the stream without writing the state event", async () => {
    let seq = 0;
    let rechecks = 0;
    const fake = fakeLoop(
      {
        checkSeq: async () => seq,
        recheck: async () => {
          rechecks += 1;
          if (rechecks > 1) throw new Error("D1_ERROR: network");
          return true;
        },
      },
      () => {
        seq = 5;
      },
    );
    await expect(runPushLoop(fake.loop)).resolves.toBeUndefined();
    expect(rechecks).toBe(2);
    // The preamble and the initial event only; every write is a whole event.
    expect(fake.writes.map((w) => w.chunk.split("\n")[0])).toEqual([
      RETRY_PREAMBLE.split("\n")[0],
      "event: state",
    ]);
    expect(fake.writes.every((w) => w.chunk.endsWith("\n\n"))).toBe(true);
  });

  it("stops when the client leaves while a seq check is in flight, writing nothing more", async () => {
    let cancelled = false;
    let checks = 0;
    const fake = fakeLoop({
      checkSeq: async () => {
        checks += 1;
        cancelled = true;
        return 9;
      },
      cancelled: () => cancelled,
    });
    await runPushLoop(fake.loop);
    expect(checks).toBe(1);
    expect(fake.writes).toHaveLength(2);
  });
});

describe("EventSource push: the budget counts from the first statement of the request", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: "edge-person", email: "edge@example.com" });
  });

  /**
   * One stream with the budget at `queryBudget` and a change before every
   * tick; returns what it wrote and every statement that reached D1.
   */
  async function streamWithBudget(apiKey: string, queryBudget?: number) {
    const counted = instrumentedD1();
    let nowMs = START_MS;
    let done: Promise<unknown> | null = null;
    const response = await openEventSource(
      new Request("http://localhost/jmap/eventsource/?types=*&ping=0", {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      { ...env, DB: counted.db } as unknown as CloudflareBindings,
      {
        queryBudget,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
          await newEmail("cbox00@saasmail.test");
        },
        waitUntil: (promise) => {
          done = promise;
        },
      },
    );
    const text = await readAll(response);
    await done;
    return { response, text, events: parseEvents(text), counted };
  }

  /** What connecting costs: authentication, the grant, the state, and the initial event's re-check. */
  async function connectCost(apiKey: string): Promise<number> {
    const counted = instrumentedD1();
    let atFirstSleep = -1;
    const abort = new AbortController();
    let done: Promise<unknown> | null = null;
    const response = await openEventSource(
      new Request("http://localhost/jmap/eventsource/?types=*&ping=0", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: abort.signal,
      }),
      { ...env, DB: counted.db } as unknown as CloudflareBindings,
      {
        now: () => START_MS,
        sleep: async () => {
          if (atFirstSleep === -1) atFirstSleep = counted.count();
          abort.abort();
        },
        waitUntil: (promise) => {
          done = promise;
        },
      },
    );
    // An aborted stream is left for the runtime to drain, not closed: read
    // only up to the event.
    const text = await readUntil(response.body!.getReader(), "event: state");
    await done;
    expect(parseEvents(text).filter((e) => e.event === "state")).toHaveLength(
      1,
    );
    return atFirstSleep;
  }

  async function memberWithGrant(id: string) {
    const { userId, apiKey } = await createTestUser({
      id,
      role: "member",
      email: `${id}@example.com`,
    });
    await grant(
      userId,
      Array.from(
        { length: 45 },
        (_, index) => `cbox${String(index).padStart(2, "0")}@saasmail.test`,
      ),
    );
    return apiKey;
  }

  it("connect costing one under, exactly, and one over the budget: two serve the event, the third closes with only retry", async () => {
    const apiKey = await memberWithGrant("edge-connect-budget");
    const cost = await connectCost(apiKey);
    expect(cost).toBeGreaterThan(2);
    expect(cost).toBeLessThan(PUSH_QUERY_BUDGET);

    // Budgets arranged so connect costs budget - 1, budget and budget + 1
    // (39, 40 and 41 against a budget of 40).
    for (const [budget, served] of [
      [cost + 1, true],
      [cost, true],
      [cost - 1, false],
    ] as const) {
      const run = await streamWithBudget(apiKey, budget);
      expect(run.response.status, `budget ${budget}`).toBe(200);
      expect(run.text.startsWith(RETRY_PREAMBLE), `budget ${budget}`).toBe(
        true,
      );
      const states = run.events.filter((e) => e.event === "state");
      expect(states.length, `budget ${budget}`).toBe(served ? 1 : 0);
      // The statement past the budget never runs.
      expect(run.counted.count(), `budget ${budget}`).toBeLessThanOrEqual(
        budget,
      );
      if (!served) expect(run.text).toBe(RETRY_PREAMBLE);
    }
  });

  it("a refusal while connecting answers 200 with only retry: during authentication or the state read", async () => {
    const apiKey = await memberWithGrant("edge-connect-refused");
    for (const budget of [0, 1, 2]) {
      const run = await streamWithBudget(apiKey, budget);
      expect(run.response.status, `budget ${budget}`).toBe(200);
      expect(run.response.headers.get("Content-Type")).toContain(
        "text/event-stream",
      );
      expect(run.text, `budget ${budget}`).toBe(RETRY_PREAMBLE);
      expect(run.counted.count(), `budget ${budget}`).toBeLessThanOrEqual(
        budget,
      );
    }
  });

  it("with the real budget, a stream never sends more than 40 statements", async () => {
    const apiKey = await memberWithGrant("edge-connect-real");
    const run = await streamWithBudget(apiKey);
    expect(
      run.events.filter((e) => e.event === "state").length,
    ).toBeGreaterThan(1);
    expect(run.counted.count()).toBeLessThanOrEqual(PUSH_QUERY_BUDGET);
  });
});
