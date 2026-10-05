import type { Context } from "hono";
import type { ParsedFile } from "./multipart-send";
import {
  DAILY_SEND_LIMIT_CODE,
  currentSendChannel,
  reserveDailySend,
} from "./sending-controls";
import {
  idempotencyFailure,
  idempotencyKeyOf,
  sendFingerprint,
  withIdempotency,
  type IdempotentResponse,
} from "./send-idempotency";

/**
 * Answers a send route: runs `run` under the request's idempotency key when
 * it has one (the `Idempotency-Key` header, else `idempotencyKey` in the
 * payload), and directly when it has none. Call it after the request is
 * parsed and validated, so a 400 never consumes a key.
 *
 * Each message that runs counts against the caller's daily limit for the
 * channel (web or API key); a replay never runs, so it never counts.
 */
export async function respondIdempotently(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any>,
  request: {
    payloadKey: unknown;
    /** The parsed request, without the key: what makes it the same request. */
    fields: Record<string, unknown>;
    files?: ParsedFile[];
  },
  run: () => Promise<IdempotentResponse>,
): Promise<Response> {
  const { key, error } = idempotencyKeyOf(
    c.req.header("Idempotency-Key"),
    request.payloadKey,
  );
  if (error) return c.json({ error, code: "INVALID_IDEMPOTENCY_KEY" }, 400);
  const counted = () => runCounted(c, run);
  const answer = (response: IdempotentResponse) => {
    for (const [name, value] of Object.entries(response.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(response.body as object, response.status as 201);
  };
  if (!key) return answer(await counted());

  try {
    const outcome = await withIdempotency(
      c.get("db"),
      {
        userId: c.get("user").id,
        key,
        // A key used over MCP answers there only: the two store different
        // answers for the same send.
        fingerprint: await sendFingerprint(
          { surface: "http", ...request.fields },
          request.files,
        ),
      },
      counted,
    );
    if (outcome.replayed) c.header("Idempotency-Replayed", "true");
    return answer(outcome);
  } catch (caught) {
    const failure = idempotencyFailure(caught);
    if (!failure) throw caught;
    if (failure.retryAfter) c.header("Retry-After", failure.retryAfter);
    return c.json(failure.body, failure.status);
  }
}

/**
 * Runs one send against the caller's daily limit: refused with 429 over the
 * limit, and the slot given back when the send is refused or fails.
 */
async function runCounted(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any>,
  run: () => Promise<IdempotentResponse>,
): Promise<IdempotentResponse> {
  const reservation = await reserveDailySend(c.get("db"), {
    userId: c.get("user").id,
    channel: currentSendChannel(),
  });
  if (!reservation.allowed) {
    return {
      status: 429,
      body: {
        error: reservation.message,
        code: DAILY_SEND_LIMIT_CODE,
        retryAfter: reservation.retryAfter,
      },
      headers: { "Retry-After": String(reservation.retryAfter) },
    };
  }
  try {
    const response = await run();
    if (response.status < 200 || response.status >= 300) {
      await reservation.release();
    }
    return response;
  } catch (error) {
    await reservation.release();
    throw error;
  }
}
