const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signToken(
  email: string,
  secret: string,
): Promise<string> {
  const payload = JSON.stringify({ e: email.toLowerCase(), v: 1 });
  const payloadBytes = encoder.encode(payload);
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payloadBytes),
  );
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(sig)}`;
}

export async function verifyToken(
  token: string,
  secret: string,
): Promise<{ email: string } | null> {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadEnc, sigEnc] = parts;

  const payloadBytes = b64urlDecode(payloadEnc);
  const sigBytes = b64urlDecode(sigEnc);
  if (!payloadBytes || !sigBytes) return null;

  const key = await hmacKey(secret);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payloadBytes),
  );
  if (!timingSafeEqual(sigBytes, expected)) return null;

  try {
    const decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (typeof decoded?.e !== "string" || decoded?.v !== 1) return null;
    return { email: decoded.e };
  } catch {
    return null;
  }
}
