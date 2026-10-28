import { describe, it, expect } from "vitest";
import { signState, verifyState } from "../lib/gmail/state";

const SECRET = "a-worker-secret-value";

describe("OAuth state", () => {
  it("round-trips the user id", async () => {
    const state = await signState("user-42", SECRET, 1_000_000);
    expect(await verifyState(state, SECRET, 1_000_060)).toBe("user-42");
  });

  it("rejects a forged signature", async () => {
    const state = await signState("user-42", SECRET, 1_000_000);
    const forged = state.slice(0, -4) + "aaaa";
    await expect(verifyState(forged, SECRET, 1_000_060)).rejects.toThrow();
  });

  it("rejects a different secret", async () => {
    const state = await signState("user-42", SECRET, 1_000_000);
    await expect(verifyState(state, "other", 1_000_060)).rejects.toThrow();
  });

  it("rejects state older than ten minutes", async () => {
    const state = await signState("user-42", SECRET, 1_000_000);
    await expect(verifyState(state, SECRET, 1_000_601)).rejects.toThrow(
      /expired/i,
    );
  });

  it("accepts state inside the ten-minute window", async () => {
    const state = await signState("user-42", SECRET, 1_000_000);
    expect(await verifyState(state, SECRET, 1_000_599)).toBe("user-42");
  });
});
