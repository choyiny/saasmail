import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyMigrations, cleanDb } from "./helpers";
import { classifyQueueMessage, handleQueueBatch } from "../lib/queue-router";

beforeAll(applyMigrations);
beforeEach(cleanDb);

/** Minimal stand-in for a Cloudflare `MessageBatch`, recording ack/retry. */
function fakeBatch(bodies: unknown[]) {
  const acked: number[] = [];
  const retried: number[] = [];
  const messages = bodies.map((body, i) => ({
    id: String(i),
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: () => void acked.push(i),
    retry: () => void retried.push(i),
  }));
  return {
    batch: {
      queue: "saasmail-sequence-emails",
      messages,
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>,
    acked,
    retried,
  };
}

describe("classifyQueueMessage", () => {
  /**
   * The deploy-window rule. Messages already in flight when the consumer that
   * understands `type` is deployed carry no `type` at all, because the only
   * producer before this change enqueued a bare `{ sequenceEmailId }`. Treating
   * those as unknown would strand real sequence mail.
   */
  it("treats a message with no type as a legacy sequence email", () => {
    expect(classifyQueueMessage({ sequenceEmailId: "se-1" })).toBe(
      "sequence_email",
    );
  });

  it("accepts an explicitly tagged sequence email", () => {
    expect(
      classifyQueueMessage({ type: "sequence_email", sequenceEmailId: "se-1" }),
    ).toBe("sequence_email");
  });

  it("recognises a list import coordinator message", () => {
    expect(classifyQueueMessage({ type: "list_import", jobId: "j-1" })).toBe(
      "list_import",
    );
  });

  const unknownBodies: Array<[string, unknown]> = [
    ["a type this build does not implement yet", { type: "campaign_fan_out" }],
    ["an unrecognised type", { type: "nonsense" }],
    ["an empty body", {}],
    ["null", null],
    ["a non-object body", "a string"],
  ];
  it.each(unknownBodies)("classifies %s as unknown", (_label, body) => {
    expect(classifyQueueMessage(body)).toBe("unknown");
  });

  it("does not treat a typed message missing its payload as a legacy sequence email", () => {
    // `{ type: 'list_import' }` with no jobId is malformed, not legacy.
    expect(classifyQueueMessage({ type: "list_import" })).toBe("unknown");
  });
});

describe("handleQueueBatch", () => {
  it("acks an unknown message instead of retrying it forever", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { batch, acked, retried } = fakeBatch([{ type: "who-knows" }]);

    await handleQueueBatch(batch, env as unknown as CloudflareBindings);

    // An unrecognised discriminant is a shipped-producer-without-consumer bug.
    // Retrying cannot make it recognisable, so it is acked and logged loudly
    // rather than burning the retry budget and delaying the rest of the queue.
    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("acks every message in demo mode without dispatching", async () => {
    const { batch, acked, retried } = fakeBatch([
      { sequenceEmailId: "se-1" },
      { type: "list_import", jobId: "j-1" },
    ]);

    await handleQueueBatch(batch, {
      ...(env as unknown as CloudflareBindings),
      DEMO_MODE: "1",
    } as CloudflareBindings);

    expect(acked).toEqual([0, 1]);
    expect(retried).toEqual([]);
  });

  it("retries a message whose handler throws, leaving the rest acked", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    // A list_import for a job that does not exist makes the handler throw.
    const { batch, acked, retried } = fakeBatch([
      { type: "list_import", jobId: "missing-job" },
      { type: "who-knows" },
    ]);

    await handleQueueBatch(batch, env as unknown as CloudflareBindings);

    expect(retried).toEqual([0]);
    expect(acked).toEqual([1]);
    warn.mockRestore();
  });
});
