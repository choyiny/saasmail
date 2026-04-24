// Web Push (RFC 8291 content encoding + RFC 8292 VAPID).
// Pure WebCrypto — no dependencies.

export function b64urlEncode(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface VapidConfig {
  publicKey: string; // base64url raw (65 bytes: 0x04 || X || Y)
  privateKey: string; // base64url 32-byte scalar
  subject: string; // e.g. "mailto:admin@example.com"
}

export async function signVapidJwt(args: {
  audience: string;
  subject: string;
  publicKey: string;
  privateKey: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const header = { alg: "ES256", typ: "JWT" };
  const exp =
    Math.floor(Date.now() / 1000) + (args.expiresInSeconds ?? 12 * 3600);
  const payload = { aud: args.audience, exp, sub: args.subject };

  const enc = (o: unknown) =>
    b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;

  // Import the private key via JWK so we can attach both d and the public x/y.
  const xy = b64urlDecode(args.publicKey); // 0x04 || X(32) || Y(32)
  if (xy.length !== 65 || xy[0] !== 0x04) {
    throw new Error("VAPID public key must be 65-byte uncompressed P-256");
  }
  const x = b64urlEncode(xy.slice(1, 33));
  const y = b64urlEncode(xy.slice(33, 65));
  const d = args.privateKey; // already base64url
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x,
    y,
    d,
    ext: true,
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

// ---- Placeholder exports for Task 4 (keeps imports valid) ----
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  icon?: string;
  badge?: string;
  data?: Record<string, unknown>;
}

async function hkdfExtract(
  salt: Uint8Array,
  ikm: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    salt,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, ikm));
}

async function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    prk,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const out = new Uint8Array(length);
  let t = new Uint8Array(0);
  let i = 1;
  let filled = 0;
  while (filled < length) {
    const data = concatBytes(t, info, new Uint8Array([i]));
    t = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
    const take = Math.min(t.length, length - filled);
    out.set(t.subarray(0, take), filled);
    filled += take;
    i++;
  }
  return out;
}

async function importEcdhPublicRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

async function deriveAes128GcmKeys(args: {
  salt: Uint8Array;
  recipientPublicRaw: Uint8Array;
  senderPublicRaw: Uint8Array;
  sharedSecret: Uint8Array; // ECDH bits
  authSecret: Uint8Array;
}): Promise<{ contentEncryptionKey: Uint8Array; nonce: Uint8Array }> {
  // RFC 8291 §3.4
  const keyInfo = concatBytes(
    new TextEncoder().encode("WebPush: info\0"),
    args.recipientPublicRaw,
    args.senderPublicRaw,
  );
  const prkKey = await hkdfExtract(args.authSecret, args.sharedSecret);
  const ikm = await hkdfExpand(
    prkKey,
    concatBytes(keyInfo, new Uint8Array([0x01])),
    32,
  );
  const prk = await hkdfExtract(args.salt, ikm);
  const cek = await hkdfExpand(
    prk,
    concatBytes(
      new TextEncoder().encode("Content-Encoding: aes128gcm\0"),
      new Uint8Array([0x01]),
    ),
    16,
  );
  const nonce = await hkdfExpand(
    prk,
    concatBytes(
      new TextEncoder().encode("Content-Encoding: nonce\0"),
      new Uint8Array([0x01]),
    ),
    12,
  );
  return { contentEncryptionKey: cek, nonce };
}

export async function encryptAes128Gcm(args: {
  recipientPublicRaw: Uint8Array;
  authSecret: Uint8Array;
  plaintext: Uint8Array;
  recordSize?: number; // default 4096
}): Promise<Uint8Array> {
  const recordSize = args.recordSize ?? 4096;
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Ephemeral sender ECDH keypair.
  const sender = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const senderPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", sender.publicKey),
  );

  const recipientPubKey = await importEcdhPublicRaw(args.recipientPublicRaw);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: recipientPubKey },
      sender.privateKey,
      256,
    ),
  );

  const { contentEncryptionKey, nonce } = await deriveAes128GcmKeys({
    salt,
    recipientPublicRaw: args.recipientPublicRaw,
    senderPublicRaw,
    sharedSecret,
    authSecret: args.authSecret,
  });

  // Pad: plaintext || 0x02 (last-record delimiter per RFC 8188).
  const padded = concatBytes(args.plaintext, new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey(
    "raw",
    contentEncryptionKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded),
  );

  // Header: salt(16) || rs(4 BE) || idlen(1) || keyid(senderPublicRaw, 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, recordSize, false);
  return concatBytes(
    salt,
    rs,
    new Uint8Array([senderPublicRaw.length]),
    senderPublicRaw,
    ciphertext,
  );
}

// Test-only helper (not exported via index; used by the unit test).
export async function decryptAes128Gcm(args: {
  body: Uint8Array;
  recipientPrivateJwkD: string;
  recipientPublicRaw: Uint8Array;
  authSecret: Uint8Array;
}): Promise<Uint8Array> {
  const salt = args.body.slice(0, 16);
  const idlen = args.body[20];
  const senderPublicRaw = args.body.slice(21, 21 + idlen);
  const ciphertext = args.body.slice(21 + idlen);

  // Rebuild recipient ECDH private from JWK.
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(args.recipientPublicRaw.slice(1, 33)),
    y: b64urlEncode(args.recipientPublicRaw.slice(33, 65)),
    d: args.recipientPrivateJwkD,
    ext: true,
  };
  const recipientPriv = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const senderPubKey = await importEcdhPublicRaw(senderPublicRaw);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: senderPubKey },
      recipientPriv,
      256,
    ),
  );
  const { contentEncryptionKey, nonce } = await deriveAes128GcmKeys({
    salt,
    recipientPublicRaw: args.recipientPublicRaw,
    senderPublicRaw,
    sharedSecret,
    authSecret: args.authSecret,
  });
  const aesKey = await crypto.subtle.importKey(
    "raw",
    contentEncryptionKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      aesKey,
      ciphertext,
    ),
  );
  // Strip padding delimiter (last byte 0x02 for single last record).
  return padded.slice(0, padded.length - 1);
}

export async function sendPush(
  sub: PushSubscriptionRecord,
  payload: PushPayload,
  vapid: VapidConfig,
  opts: {
    ttl?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
  } = {},
): Promise<{ status: number }> {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;

  const jwt = await signVapidJwt({
    audience,
    subject: vapid.subject,
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  });

  const body = await encryptAes128Gcm({
    recipientPublicRaw: b64urlDecode(sub.p256dh),
    authSecret: b64urlDecode(sub.auth),
    plaintext: new TextEncoder().encode(JSON.stringify(payload)),
  });

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      TTL: String(opts.ttl ?? 60),
      Urgency: opts.urgency ?? "normal",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body,
  });
  return { status: res.status };
}
