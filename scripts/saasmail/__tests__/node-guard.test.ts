import { describe, expect, it } from "vitest";
import { nodeProblem } from "../node-guard.ts";

describe("nodeProblem", () => {
  it("accepts 22.18 and newer", () => {
    for (const v of ["22.18.0", "22.20.1", "23.0.0", "24.1.0"])
      expect(nodeProblem(v)).toBeUndefined();
  });
  it("names the found version when older", () => {
    for (const v of ["22.17.9", "20.11.0", "18.19.1"])
      expect(nodeProblem(v)).toBe(
        `yarn saasmail needs Node.js 22.18 or newer (found ${v}).`,
      );
  });
});
