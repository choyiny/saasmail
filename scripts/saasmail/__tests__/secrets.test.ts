import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { describe, expect, it } from "vitest";
import {
  generateEncryptionKey,
  generateHexSecret,
  generateSetupCode,
  generateVapidKeys,
  setupCodeHash,
  withSecretsFile,
} from "../secrets.ts";

// The Worker's algorithm (worker/src/lib/setup-code.ts), run through WebCrypto as it does.
async function workerHash(code: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code.replace(/[\s-]/g, "").toUpperCase()),
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("setup code", () => {
  it("matches the Worker normalisation", async () => {
    const hex = createHash("sha256")
      .update("ABCDEFGHJKMNPQRSTUVW")
      .digest("hex");
    expect(setupCodeHash("ABCDEFGHJKMNPQRSTUVW")).toBe(hex);
    expect(setupCodeHash(" abcd-efgh jkmn-pqrs-tuvw \n")).toBe(hex);
    for (const c of ["abcd-efgh-jkmn-pqrs-tuvw", " X-y z\n", ""])
      expect(setupCodeHash(c)).toBe(await workerHash(c));
  });
  it("hashes a fixed vector", () => {
    expect(setupCodeHash("ABCD-EFGH-JKMN-PQRS-TUVW")).toBe(
      "d1d5079c636ac8353aa6acc43178ca940837a4dbc13028a5d93376fff410df65",
    );
  });
  it("has the documented format", () => {
    for (let i = 0; i < 50; i++)
      expect(generateSetupCode()).toMatch(
        /^([A-HJKMNP-Z2-9]{4}-){4}[A-HJKMNP-Z2-9]{4}$/,
      );
  });
});

describe("generated secrets", () => {
  it("hex secret is 64 hex chars and random", () => {
    expect(generateHexSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateHexSecret()).not.toBe(generateHexSecret());
  });
  it("encryption key is standard base64 of 32 bytes", () => {
    const k = generateEncryptionKey();
    expect(k).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(k, "base64")).toHaveLength(32);
    expect(Uint8Array.from(atob(k), (c) => c.charCodeAt(0))).toHaveLength(32);
    expect(generateEncryptionKey()).not.toBe(k);
  });
  it("VAPID keys use the generate-vapid encoding and pair up", () => {
    const { publicKey, privateKey } = generateVapidKeys();
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    const pub = Buffer.from(publicKey, "base64url");
    const priv = Buffer.from(privateKey, "base64url");
    expect(pub).toHaveLength(65);
    expect(pub[0]).toBe(0x04);
    expect(priv).toHaveLength(32);
    const jwk = {
      kty: "EC",
      crv: "P-256",
      d: privateKey,
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
    };
    const derived = createPublicKey(
      createPrivateKey({ key: jwk, format: "jwk" }),
    ).export({ format: "jwk" }) as { x: string; y: string };
    expect(derived.x).toBe(jwk.x);
    expect(derived.y).toBe(jwk.y);
  });
});

describe("withSecretsFile", () => {
  it("writes a 0600 JSON file and removes it afterwards", async () => {
    let p = "";
    const out = await withSecretsFile({ A: "x", B: "y" }, async (path) => {
      p = path;
      // One descriptor for both checks, so the mode and the contents are the same file's.
      const fd = openSync(path, "r");
      const mode = fstatSync(fd).mode;
      const text = readFileSync(fd, "utf8");
      closeSync(fd);
      expect(mode & 0o777).toBe(0o600);
      expect(JSON.parse(text)).toEqual({
        A: "x",
        B: "y",
      });
      return 7;
    });
    expect(out).toBe(7);
    expect(existsSync(p)).toBe(false);
  });
  it("removes it when fn throws", async () => {
    let p = "";
    await expect(
      withSecretsFile({ A: "x" }, async (path) => {
        p = path;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(p)).toBe(false);
  });
});
