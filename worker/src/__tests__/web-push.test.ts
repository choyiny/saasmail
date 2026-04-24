import { describe, it, expect } from "vitest";
import {
  b64urlEncode,
  b64urlDecode,
  signVapidJwt,
  encryptAes128Gcm,
  decryptAes128Gcm,
} from "../lib/web-push";

describe("web-push: base64url", () => {
  it("round-trips binary data", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const enc = b64urlEncode(bytes);
    expect(enc).not.toMatch(/[+/=]/);
    const dec = b64urlDecode(enc);
    expect(Array.from(dec)).toEqual(Array.from(bytes));
  });
});

describe("web-push: VAPID JWT", () => {
  it("produces a valid ES256 JWT with the expected claims", async () => {
    // Fresh keypair for the test so we don't depend on fixtures.
    const kp = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", kp.publicKey),
    );
    const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as {
      d: string;
    };
    const privateKey = b64urlEncode(b64urlDecode(jwk.d));
    const publicKey = b64urlEncode(raw);

    const jwt = await signVapidJwt({
      audience: "https://fcm.googleapis.com",
      subject: "mailto:admin@example.com",
      publicKey,
      privateKey,
      expiresInSeconds: 3600,
    });

    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const header = JSON.parse(
      new TextDecoder().decode(b64urlDecode(headerB64)),
    );
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(payloadB64)),
    );
    expect(header).toEqual({ alg: "ES256", typ: "JWT" });
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe("mailto:admin@example.com");
    expect(typeof payload.exp).toBe("number");

    // Verify signature with the public key.
    const sig = b64urlDecode(sigB64);
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      kp.publicKey,
      sig,
      data,
    );
    expect(ok).toBe(true);
  });
});

describe("web-push: aes128gcm", () => {
  it("encrypt/decrypt round-trip with a freshly generated recipient key", async () => {
    // Recipient keypair simulating the browser's push subscription.
    const recipient = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const recipientRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", recipient.publicKey),
    );
    const recipientJwk = (await crypto.subtle.exportKey(
      "jwk",
      recipient.privateKey,
    )) as { d: string };

    const auth = crypto.getRandomValues(new Uint8Array(16));
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ hello: "world" }),
    );

    const body = await encryptAes128Gcm({
      recipientPublicRaw: recipientRaw,
      authSecret: auth,
      plaintext,
    });

    const decoded = await decryptAes128Gcm({
      body,
      recipientPrivateJwkD: recipientJwk.d,
      recipientPublicRaw: recipientRaw,
      authSecret: auth,
    });
    expect(new TextDecoder().decode(decoded)).toBe(
      JSON.stringify({ hello: "world" }),
    );
  });
});
