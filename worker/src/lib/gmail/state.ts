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

/**
 * base64url, so an arbitrary address can ride inside a `.`-delimited payload
 * without making the parse ambiguous. Addresses contain dots; this is the
 * reason the third field is encoded rather than embedded raw.
 */
function encodeField(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeField(value: string): string {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (ch) => ch.charCodeAt(0)),
  );
}

export type OAuthState = {
  userId: string;
  /**
   * The mailbox this flow was started for, when it was started from a
   * specific account's Reconnect. The callback refuses a grant for any other
   * mailbox: `login_hint` only *suggests* an account, and the operator can
   * still pick a different one at Google's chooser.
   */
  expectedEmail: string | null;
};

export async function signState(
  userId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  expectedEmail: string | null = null,
): Promise<string> {
  // The two-field form is kept byte-identical for a plain connect, so a state
  // signed before this field existed still verifies.
  const payload =
    expectedEmail === null
      ? `${userId}.${nowSeconds}`
      : `${userId}.${nowSeconds}.${encodeField(expectedEmail)}`;
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifyState(
  state: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<OAuthState> {
  const parts = state.split(".");
  // Defence in depth against delimiter injection: it keeps parsing into
  // userId/issuedAt/[expectedEmail]/signature unambiguous. It is not what
  // stops forgery — the HMAC is computed over the full reconstructed payload
  // below, so the signature check is the actual protection.
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error("malformed OAuth state");
  }
  const signature = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join(".");
  const expected = await hmac(payload, secret);
  if (!timingSafeEqual(signature, expected)) {
    throw new Error("invalid OAuth state signature");
  }
  const [userId, issuedAtRaw] = parts;
  // Only the four-field form carries a mailbox; in the three-field form
  // parts[2] is the signature.
  const encodedEmail = parts.length === 4 ? parts[2] : undefined;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) throw new Error("malformed OAuth state");
  if (nowSeconds - issuedAt > MAX_AGE_SECONDS) {
    throw new Error("OAuth state expired");
  }
  let expectedEmail: string | null = null;
  if (encodedEmail !== undefined) {
    try {
      expectedEmail = decodeField(encodedEmail);
    } catch {
      throw new Error("malformed OAuth state");
    }
  }
  return { userId, expectedEmail };
}
