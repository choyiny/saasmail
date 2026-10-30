import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { forgetSendKey, sendKeyFor, sendKeyProblem } from "@/lib/send-key";

describe("send keys of the web composers", () => {
  beforeEach(() => {
    sessionStorage.clear();
    forgetSendKey("compose");
    forgetSendKey("reply:e1");
  });

  it("keeps one key per context until it is forgotten", () => {
    const first = sendKeyFor("compose");
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(sendKeyFor("compose")).toBe(first);
    expect(sendKeyFor("reply:e1")).not.toBe(first);

    forgetSendKey("compose");
    expect(sendKeyFor("compose")).not.toBe(first);
  });

  it("survives a reload of the tab through sessionStorage", () => {
    const key = sendKeyFor("compose");
    expect(sessionStorage.getItem("saasmail:send-key:compose")).toBe(key);
  });

  it("explains a refused key, and replaces a reused one", () => {
    const key = sendKeyFor("compose");
    const reused = new ApiError("used", 422, "IDEMPOTENCY_KEY_REUSED");
    expect(sendKeyProblem(reused, "compose")).toContain(
      "This message was not sent",
    );
    expect(sendKeyFor("compose")).not.toBe(key);

    const kept = sendKeyFor("compose");
    const running = new ApiError("running", 409, "IDEMPOTENCY_IN_PROGRESS");
    expect(sendKeyProblem(running, "compose")).toContain("still sending");
    expect(sendKeyFor("compose")).toBe(kept);

    expect(sendKeyProblem(new Error("network"), "compose")).toBeNull();
    expect(sendKeyProblem(new ApiError("x", 500, null), "compose")).toBeNull();
  });
});
