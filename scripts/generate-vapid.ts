#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Generate a P-256 (prime256v1) ECDSA keypair for VAPID.
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});

// Export the public key as the 65-byte uncompressed SEC1 point (0x04 || X || Y).
const publicJwk = publicKey.export({ format: "jwk" }) as {
  x: string;
  y: string;
};
const xBuf = Buffer.from(publicJwk.x, "base64url");
const yBuf = Buffer.from(publicJwk.y, "base64url");
const publicRaw = Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);

// Export the private key as the 32-byte scalar.
const privJwk = privateKey.export({ format: "jwk" }) as {
  d: string;
};
const privateRaw = Buffer.from(privJwk.d, "base64url");

const vapidPublic = b64url(publicRaw);
const vapidPrivate = b64url(privateRaw);

console.log(`
VAPID keypair generated.

Public key (safe to put in wrangler.jsonc "vars"):
  VAPID_PUBLIC_KEY="${vapidPublic}"

Private key (store as a Cloudflare secret — do NOT commit):
  wrangler secret put VAPID_PRIVATE_KEY
  # when prompted, paste:
  ${vapidPrivate}

Contact subject (required by push services; mailto: or https:):
  VAPID_SUBJECT="mailto:admin@<your-domain>"

Add VAPID_PUBLIC_KEY and VAPID_SUBJECT to the "vars" block of wrangler.jsonc
and run \`wrangler types\` to refresh worker-configuration.d.ts.
`);
