const encoder = new TextEncoder();

/**
 * The four independent token purposes in the newsletter module.
 *
 * Each gets its own signing key derived from the root secret, so a token that
 * leaks from one context cannot be replayed against another. That matters most
 * for `track-open`: a tracking-pixel URL travels through image caches, proxy
 * logs and browser history, where an unsubscribe link generally does not.
 */
export type TokenDomain =
  | "subscribe-confirm"
  | "unsubscribe"
  | "track-open"
  | "track-click";

/**
 * Derive a per-domain signing key from the root secret.
 *
 * This is HMAC used as a one-block KDF: `key(domain) = HMAC(secret, label)`.
 * It deliberately reuses the primitive `unsubscribe-token.ts` already relies on
 * rather than pulling in an HKDF implementation, and it needs no new secret to
 * be provisioned — `UNSUBSCRIBE_SECRET` stays the single root.
 *
 * The label is prefixed and version-tagged so a future scheme change can move
 * to a new label set without any chance of colliding with tokens already in
 * flight inside delivered email.
 */
async function deriveDomainKey(
  secret: string,
  domain: TokenDomain,
): Promise<CryptoKey> {
  const rootKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    rootKey,
    encoder.encode(`saasmail:token:v1:${domain}`),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

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

/** Constant-time compare, so a wrong signature leaks no timing information. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** A payload may carry `exp` (unix seconds); everything else is domain-specific. */
export type TokenPayload = Record<string, unknown> & { exp?: number };

export async function signPayload(
  payload: TokenPayload,
  secret: string,
  domain: TokenDomain,
): Promise<string> {
  const bytes = encoder.encode(JSON.stringify(payload));
  const key = await deriveDomainKey(secret, domain);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return `${b64urlEncode(bytes)}.${b64urlEncode(sig)}`;
}

export type VerifyResult =
  | { status: "valid"; payload: TokenPayload }
  | { status: "expired" }
  | { status: "invalid" };

async function verify(
  token: string,
  secret: string,
  domain: TokenDomain,
): Promise<VerifyResult> {
  if (!token || typeof token !== "string") return { status: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 2) return { status: "invalid" };

  const payloadBytes = b64urlDecode(parts[0]);
  const sigBytes = b64urlDecode(parts[1]);
  if (!payloadBytes || !sigBytes) return { status: "invalid" };

  const key = await deriveDomainKey(secret, domain);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payloadBytes),
  );
  if (!timingSafeEqual(sigBytes, expected)) return { status: "invalid" };

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { status: "invalid" };
  }
  if (typeof decoded !== "object" || decoded === null) {
    return { status: "invalid" };
  }

  const payload = decoded as TokenPayload;
  // Expiry is checked only after the signature, so an attacker cannot use the
  // response to distinguish "forged" from "expired" on a token they made up.
  if (typeof payload.exp === "number") {
    if (payload.exp <= Math.floor(Date.now() / 1000))
      return { status: "expired" };
  }
  return { status: "valid", payload };
}

/**
 * Verify a token.
 *
 * Returns the payload, or `null` when the token is unusable for any reason.
 * Pass `{ detailed: true }` when the caller needs to tell "expired" from
 * "invalid" — the subscribe-confirm endpoint does, so it can answer 410 Gone
 * (re-subscribe) rather than a flat rejection.
 */
export async function verifyPayload(
  token: string,
  secret: string,
  domain: TokenDomain,
): Promise<TokenPayload | null>;
export async function verifyPayload(
  token: string,
  secret: string,
  domain: TokenDomain,
  opts: { detailed: true },
): Promise<{ status: "expired" } | { status: "invalid" } | TokenPayload>;
export async function verifyPayload(
  token: string,
  secret: string,
  domain: TokenDomain,
  opts?: { detailed: true },
): Promise<unknown> {
  const result = await verify(token, secret, domain);
  if (opts?.detailed) {
    return result.status === "valid"
      ? result.payload
      : { status: result.status };
  }
  return result.status === "valid" ? result.payload : null;
}
