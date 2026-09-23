import { describe, it, expect } from "vitest";
import { signState, verifyState } from "../lib/gmail/state";

const SECRET = "a-worker-secret-value";

describe("OAuth state", () => {
  it("round-trips the user id", async () => {
    const state = await signState("user-42", SECRET, 1_000_000);
    expect(await verifyState(state, SECRET, 1_000_060)).toEqual({
      userId: "user-42",
      expectedEmail: null,
    });
  });

  it("round-trips the mailbox a reconnect is aimed at", async () => {
    // The address contains dots, which is the whole reason it is encoded
    // rather than appended raw to a dot-delimited payload.
    const state = await signState(
      "user-42",
      SECRET,
      1_000_000,
      "ops@mail.acme.co.uk",
    );
    expect(await verifyState(state, SECRET, 1_000_060)).toEqual({
      userId: "user-42",
      expectedEmail: "ops@mail.acme.co.uk",
    });
  });

  it("rejects a tampered expected mailbox", async () => {
    // Swapping the target mailbox is the attack this field must survive:
    // it decides which row the callback is allowed to write.
    const state = await signState(
      "user-42",
      SECRET,
      1_000_000,
      "ops@example.com",
    );
    const parts = state.split(".");
    parts[2] = btoa("jane@example.com")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(
      verifyState(parts.join("."), SECRET, 1_000_060),
    ).rejects.toThrow(/signature/i);
  });

  it("does not carry a mailbox when none was asked for", async () => {
    const state = await signState("user-42", SECRET, 1_000_000, null);
    expect(state.split(".")).toHaveLength(3);
    expect((await verifyState(state, SECRET, 1_000_060)).expectedEmail).toBe(
      null,
    );
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
    expect((await verifyState(state, SECRET, 1_000_599)).userId).toBe(
      "user-42",
    );
  });
});
