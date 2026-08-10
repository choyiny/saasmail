import { describe, expect, it } from "vitest";
import {
  D1_MAX_BOUND_PARAMS,
  chunkForD1BoundParams,
} from "../lib/helpers";

describe("chunkForD1BoundParams", () => {
  it("returns no chunks for an empty list", () => {
    expect(chunkForD1BoundParams([], 1)).toEqual([]);
  });

  it("keeps a small list as a single chunk", () => {
    expect(chunkForD1BoundParams(["a", "b", "c"], 1)).toEqual([
      ["a", "b", "c"],
    ]);
  });

  it("chunks so each statement stays under the D1 bind cap", () => {
    const ids = Array.from({ length: 57 }, (_, i) => `c_${i}`);
    // Historical bug: UNION bound the same id list twice → 57*2=114 > 100.
    const chunks = chunkForD1BoundParams(ids, 2);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length * 2).toBeLessThan(D1_MAX_BOUND_PARAMS);
    }
    expect(chunks.flat()).toEqual(ids);
  });

  it("uses almost the full bind budget for a single IN list", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id_${i}`);
    const chunks = chunkForD1BoundParams(ids, 1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThan(D1_MAX_BOUND_PARAMS);
    }
    expect(chunks.flat()).toEqual(ids);
  });
});
