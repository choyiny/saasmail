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
  it("package floor accepts 22.0.0 and names Node 22", () => {
    expect(nodeProblem("22.0.0", [22, 0])).toBeUndefined();
    expect(nodeProblem("21.7.3", [22, 0])).toBe(
      "saasmail needs Node.js 22 or newer (found 21.7.3).",
    );
  });
});
