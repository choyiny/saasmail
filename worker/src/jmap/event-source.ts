import { createDb } from "../db/client";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { authenticateJmap, problem } from "./auth";
import {
  PUSH_KEEPALIVE_SECONDS,
  PUSH_LIFETIME_SECONDS,
  PUSH_MAX_PING_SECONDS,
  PUSH_MIN_PING_SECONDS,
  PUSH_QUERY_BUDGET,
  PUSH_TICK_SECONDS,
} from "./constants";
import { publicAccountId } from "./public-ids";
import {
  currentJmapSeq,
  currentJmapSeqQueries,
  currentJmapState,
  formatJmapState,
  jmapStateIssuedAt,
  stateFingerprint,
} from "./state";

/**
 * The data types a push stream reports. They share one state string today
 * (`currentJmapState`), so a change to any of them moves all four.
 */
export const PUSH_TYPES = [
  "Email",
  "Mailbox",
  "Thread",
  "EmailSubmission",
] as const;
export type PushType = (typeof PUSH_TYPES)[number];

export type EventSourceParams = {
  types: PushType[];
  closeAfterState: boolean;
  /** Seconds between `ping` events; 0 sends none. */
  pingSeconds: number;
};

export const RETRY_PREAMBLE = "retry: 5000\n\n";
export const KEEPALIVE_COMMENT = ": keepalive\n\n";

/**
 * The query string of an EventSource request (RFC 8620 §7.3). Strict mode is
 * off, so the outcome carries a nullable `error` rather than a union.
 */
export function parseEventSourceParams(url: URL): {
  params: EventSourceParams | null;
  error: string | null;
} {
  const typesValue = url.searchParams.get("types");
  let types: PushType[];
  if (typesValue === null || typesValue.trim() === "*") {
    types = [...PUSH_TYPES];
  } else {
    // Unknown names are ignored; the stream still runs with none left.
    const named = new Set(typesValue.split(",").map((name) => name.trim()));
    types = PUSH_TYPES.filter((type) => named.has(type));
  }

  const closeAfter = url.searchParams.get("closeafter") ?? "no";
  if (closeAfter !== "state" && closeAfter !== "no") {
    return { params: null, error: "closeafter must be state or no." };
  }

  const pingValue = url.searchParams.get("ping") ?? "0";
  if (!/^\d+$/.test(pingValue)) {
    return {
      params: null,
      error: "ping must be a non-negative integer number of seconds.",
    };
  }
  const requestedPing = Number(pingValue);
  const pingSeconds =
    requestedPing === 0
      ? 0
      : Math.ceil(
          Math.min(
            Math.max(requestedPing, PUSH_MIN_PING_SECONDS),
            PUSH_MAX_PING_SECONDS,
          ) / PUSH_TICK_SECONDS,
        ) * PUSH_TICK_SECONDS;

  return {
    params: { types, closeAfterState: closeAfter === "state", pingSeconds },
    error: null,
  };
}

/** A `StateChange` event (one line of JSON: go-jmap reads one `data:` line). */
export function formatStateEvent(
  accountId: string,
  types: readonly PushType[],
  state: string,
): string {
  const changed: Record<string, string> = {};
  for (const type of types) changed[type] = state;
  const data = JSON.stringify({
    "@type": "StateChange",
    changed: { [accountId]: changed },
  });
  return `event: state\ndata: ${data}\n\n`;
}

export function formatPingEvent(interval: number): string {
  return `event: ping\ndata: ${JSON.stringify({ interval })}\n\n`;
}

/** Everything the tick loop needs from the outside, injected so tests drive time. */
export type PushLoop = {
  accountId: string;
  params: EventSourceParams;
  /** The state fingerprint computed at connect. */
  fingerprint: string;
  /** The state string at connect. */
  connectState: string;
  /** Queries one `checkSeq` call costs. */
  seqQueryCount: number;
  /**
   * Queries one `recheck` is expected to cost (default 0). The loop raises it
   * to the most any re-check actually used.
   */
  recheckQueryCount?: number;
  sleep(ms: number): Promise<void>;
  /** Milliseconds. */
  now(): number;
  /** The caller's change-log head (only the seq queries). */
  checkSeq(): Promise<number>;
  /**
   * Re-authenticates the caller and re-resolves their inboxes: false when the
   * credential is gone or the inbox fingerprint changed.
   */
  recheck(): Promise<boolean>;
  /** D1 queries the stream has used so far, connect included. */
  queriesUsed(): number;
  /** The most D1 queries the stream may use, connect included (default `PUSH_QUERY_BUDGET`). */
  budget?: number;
  /** False when the client is gone. */
  write(chunk: string): boolean;
  /** True once the client disconnected. */
  cancelled(): boolean;
};

/**
 * Writes the stream until it should close: the lifetime or the query budget
 * ran out, the client left, the caller lost access, a DB call failed, or a
 * `closeafter=state` stream sent its event. Never throws.
 */
export async function runPushLoop(loop: PushLoop): Promise<void> {
  const { params } = loop;
  const start = loop.now();
  let lastWrite = start;
  let lastPing = start;
  let lastState = loop.connectState;
  const wantsState = params.types.length > 0;
  let recheckCost = loop.recheckQueryCount ?? 0;
  const budget = loop.budget ?? PUSH_QUERY_BUDGET;

  const send = (chunk: string): boolean => {
    if (loop.cancelled() || !loop.write(chunk)) return false;
    lastWrite = loop.now();
    return true;
  };
  const sendState = async (state: string): Promise<boolean> => {
    // Access is re-checked before every state event: a revoked key or a
    // removed inbox must not learn that anything changed. The re-check is
    // reserved first, the initial one included: one that can't fit the budget
    // ends the stream without the event.
    if (loop.queriesUsed() + recheckCost > budget) return false;
    const before = loop.queriesUsed();
    const allowed = await loop.recheck();
    recheckCost = Math.max(recheckCost, loop.queriesUsed() - before);
    if (!allowed || loop.cancelled()) return false;
    return send(formatStateEvent(loop.accountId, params.types, state));
  };

  try {
    if (!send(RETRY_PREAMBLE)) return;
    if (wantsState && !params.closeAfterState) {
      if (!(await sendState(lastState))) return;
    }

    while (!loop.cancelled()) {
      await loop.sleep(PUSH_TICK_SECONDS * 1000);
      if (loop.cancelled()) return;
      const now = loop.now();
      if (now - start >= PUSH_LIFETIME_SECONDS * 1000) return;

      if (wantsState) {
        // A tick may cost the seq check and, when the state moved, a re-check:
        // start one only if both fit the budget.
        if (loop.queriesUsed() + loop.seqQueryCount + recheckCost > budget) {
          return;
        }
        const seq = await loop.checkSeq();
        if (loop.cancelled()) return;
        const state = formatJmapState(
          seq,
          jmapStateIssuedAt(Math.floor(now / 1000)),
          loop.fingerprint,
        );
        if (state !== lastState) {
          if (!(await sendState(state))) return;
          lastState = state;
          if (params.closeAfterState) return;
        }
      }

      if (
        params.pingSeconds > 0 &&
        now - lastPing >= params.pingSeconds * 1000
      ) {
        if (!send(formatPingEvent(params.pingSeconds))) return;
        lastPing = now;
      }
      if (now - lastWrite >= PUSH_KEEPALIVE_SECONDS * 1000) {
        if (!send(KEEPALIVE_COMMENT)) return;
      }
    }
  } catch {
    // A DB error, or a statement the budget refused, ends the stream; nothing
    // half-built was written.
  }
}

/** Thrown by the stream's D1 wrapper for a statement past the query budget. */
export class PushBudgetExceeded extends Error {
  constructor() {
    super("EventSource query budget exhausted");
    this.name = "PushBudgetExceeded";
  }
}

/**
 * Counts the statements a stream sends to D1. `count` runs before each one and
 * throws to refuse it, so a statement past the budget never reaches D1.
 */
function countingD1(db: D1Database, count: () => void): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (typeof value !== "function") return value;
      if (prop === "prepare" || prop === "exec") {
        return (...args: unknown[]) => {
          count();
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}

/** The exact permission scope: admin, or a member of exactly these inboxes. */
function scopeKey(allowed: AllowedInboxes): string {
  if (!("inboxes" in allowed)) return allowed.isAdmin ? "admin" : "none";
  const inboxes = [
    ...new Set(allowed.inboxes.map((inbox) => inbox.toLowerCase())),
  ].sort();
  return `member:${inboxes.join(",")}`;
}

/** A stream that closes at once with only the reconnect delay: clients back off and retry. */
function closedEventStream(): Response {
  return new Response(RETRY_PREAMBLE, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

/**
 * `GET /jmap/eventsource/` (RFC 8620 §7.3): a `text/event-stream` that reports
 * state changes until it closes after `PUSH_LIFETIME_SECONDS` or
 * `PUSH_QUERY_BUDGET` queries. Clients reconnect on a clean close.
 *
 * The budget covers the whole request from its first statement: the D1
 * wrapper refuses the one past it before it runs. A refusal while connecting
 * (authentication, the grant, the first state) answers `200` with only the
 * `retry:` line and no event.
 */
export async function openEventSource(
  request: Request,
  env: CloudflareBindings,
  options: {
    waitUntil?: (promise: Promise<unknown>) => void;
    /** Test seams: the clock (milliseconds) and the wait between ticks. */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Test seam: the query budget (default `PUSH_QUERY_BUDGET`). */
    queryBudget?: number;
  } = {},
): Promise<Response> {
  const now = options.now ?? (() => Date.now());
  const budget = options.queryBudget ?? PUSH_QUERY_BUDGET;
  let queries = 0;
  // Set once the wrapper refuses a statement, so a refusal that some caller
  // catches and turns into something else (a failed login) is still seen.
  let refused = false;
  const countedEnv = {
    ...env,
    DB: countingD1(env.DB, () => {
      if (queries >= budget) {
        refused = true;
        throw new PushBudgetExceeded();
      }
      queries += 1;
    }),
  } as CloudflareBindings;
  const db = createDb(countedEnv);

  let auth: Awaited<ReturnType<typeof authenticateJmap>>;
  try {
    auth = await authenticateJmap(request, countedEnv, db);
  } catch (error) {
    if (refused) return closedEventStream();
    throw error;
  }
  if (refused) return closedEventStream();
  if (auth instanceof Response) return auth;
  const authQueries = queries;

  const parsed = parseEventSourceParams(new URL(request.url));
  if (parsed.error !== null) {
    return problem(400, "about:blank", "Bad Request", parsed.error);
  }
  const params = parsed.params as EventSourceParams;

  const userId: string = auth.user.id;
  const allowed = auth.allowed;
  const seqQueryCount = currentJmapSeqQueries(allowed, userId).length;
  const beforeState = queries;
  let connect: Awaited<ReturnType<typeof currentJmapState>>;
  try {
    connect = await currentJmapState(
      db,
      allowed,
      userId,
      Math.floor(now() / 1000),
    );
  } catch (error) {
    if (refused) return closedEventStream();
    throw error;
  }
  // A re-check is the authentication again plus the fingerprint (what the
  // connect state cost beyond its seq queries).
  const recheckQueryCount =
    authQueries + (queries - beforeState - seqQueryCount);
  const scope = scopeKey(allowed);
  // Only the headers carry the credential; keep them for the re-checks.
  const credential = new Request(request.url, { headers: request.headers });

  let cancelled = false;
  const wakers = new Set<() => void>();
  const encoder = new TextEncoder();
  const stop = () => {
    cancelled = true;
    for (const wake of [...wakers]) wake();
  };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    // A reader in this isolate cancelling the body.
    cancel: stop,
  });
  // A client that disconnects over HTTP never reaches cancel(): the runtime
  // keeps draining the stream, so enqueue() keeps succeeding. What does reach
  // the handler is request.signal, which aborts on disconnect with the
  // enable_request_signal compatibility flag (wrangler.jsonc).
  request.signal?.addEventListener("abort", stop);
  if (request.signal?.aborted) stop();

  const timerSleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (cancelled) return resolve();
      const wake = () => {
        clearTimeout(timer);
        wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      wakers.add(wake);
    });

  const done = runPushLoop({
    accountId: publicAccountId(userId),
    params,
    fingerprint: connect.parts.fp,
    connectState: connect.state,
    seqQueryCount,
    recheckQueryCount,
    budget,
    sleep: options.sleep ?? timerSleep,
    now,
    checkSeq: () => currentJmapSeq(db, allowed, userId),
    recheck: async () => {
      const again = await authenticateJmap(credential, countedEnv, db);
      if (again instanceof Response || again.user.id !== userId) return false;
      // The seq checks run with the connect-time scope: an admin demoted to a
      // member (even of the same inboxes) or any grant change ends the stream.
      if (scopeKey(again.allowed) !== scope) return false;
      return (
        (await stateFingerprint(db, again.allowed, userId)) === connect.parts.fp
      );
    },
    queriesUsed: () => queries,
    write: (chunk) => {
      if (cancelled) return false;
      try {
        controller.enqueue(encoder.encode(chunk));
        return true;
      } catch {
        stop();
        return false;
      }
    },
    cancelled: () => cancelled,
  }).finally(() => {
    for (const wake of [...wakers]) wake();
    request.signal?.removeEventListener("abort", stop);
    if (cancelled) return;
    try {
      controller.close();
    } catch {
      // Already closed or errored by the client going away.
    }
  });
  options.waitUntil?.(done.catch(() => undefined));

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
