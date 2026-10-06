import { describe, it, expect } from "vitest";
import { hashKey, encryptSecret, decryptSecret } from "../lib/crypto";

describe("hashKey", () => {
  it("returns a hex string of 64 characters (SHA-256)", async () => {
    const result = await hashKey("test-key");
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", async () => {
    const a = await hashKey("same-input");
    const b = await hashKey("same-input");
    expect(a).toBe(b);
  });

  it("produces different hashes for different inputs", async () => {
    const a = await hashKey("key-1");
    const b = await hashKey("key-2");
    expect(a).not.toBe(b);
  });

  it("handles empty string", async () => {
    const result = await hashKey("");
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles special characters", async () => {
    const result = await hashKey("sk_abc123!@#$%^&*()");
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

// A 32-byte key, base64-encoded, as TOKEN_ENCRYPTION_KEY would supply.
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value", async () => {
    const sealed = await encryptSecret("1//refresh-token-abc", KEY);
    expect(await decryptSecret(sealed, KEY)).toBe("1//refresh-token-abc");
  });

  it("produces different ciphertext each time (random IV)", async () => {
    const a = await encryptSecret("same", KEY);
    const b = await encryptSecret("same", KEY);
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, KEY)).toBe("same");
    expect(await decryptSecret(b, KEY)).toBe("same");
  });

  it("rejects a tampered payload", async () => {
    const sealed = await encryptSecret("secret", KEY);
    const bytes = Uint8Array.from(atob(sealed), (ch) => ch.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(decryptSecret(tampered, KEY)).rejects.toThrow();
  });

  it("rejects the wrong key", async () => {
    const sealed = await encryptSecret("secret", KEY);
    await expect(decryptSecret(sealed, OTHER_KEY)).rejects.toThrow();
  });

  it("handles unicode", async () => {
    const sealed = await encryptSecret("réfrèsh–tøken–✉", KEY);
    expect(await decryptSecret(sealed, KEY)).toBe("réfrèsh–tøken–✉");
  });
});
