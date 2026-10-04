import type { Context } from "hono";
import type { ParsedFile } from "./multipart-send";
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
  if (!key) {
    const response = await run();
    return c.json(response.body as object, response.status as 201);
  }

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
      run,
    );
    if (outcome.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(outcome.body as object, outcome.status as 201);
  } catch (caught) {
    const failure = idempotencyFailure(caught);
    if (!failure) throw caught;
    if (failure.retryAfter) c.header("Retry-After", failure.retryAfter);
    return c.json(failure.body, failure.status);
  }
}
