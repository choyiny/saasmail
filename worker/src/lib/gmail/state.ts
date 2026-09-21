const MAX_AGE_SECONDS = 600;

async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return Array.from(sig)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time string compare, to keep signature checks non-leaky. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signState(
  userId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload = `${userId}.${nowSeconds}`;
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifyState(
  state: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const parts = state.split(".");
  if (parts.length !== 3) throw new Error("malformed OAuth state");
  const [userId, issuedAtRaw, signature] = parts;
  const expected = await hmac(`${userId}.${issuedAtRaw}`, secret);
  if (!timingSafeEqual(signature, expected)) {
    throw new Error("invalid OAuth state signature");
  }
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) throw new Error("malformed OAuth state");
  if (nowSeconds - issuedAt > MAX_AGE_SECONDS) {
    throw new Error("OAuth state expired");
  }
  return userId;
}
