import { describe, it, expect } from "vitest";

describe("web test harness", () => {
  it("runs in jsdom", () => {
    expect(typeof document).toBe("object");
    expect(document.createElement("div")).toBeTruthy();
  });
});
