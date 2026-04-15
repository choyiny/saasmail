import { eq } from "drizzle-orm";
import { apiKeys } from "../db/api-keys.schema";
import { users } from "../db/auth.schema";
import type { Variables } from "../variables";

export const API_KEY_PREFIX = "cmail_";
const KEY_RANDOM_BYTES = 30;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function generateApiKey(): { fullKey: string; prefix: string } {
  const random = new Uint8Array(KEY_RANDOM_BYTES);
  crypto.getRandomValues(random);
  const body = toBase64Url(random);
  const fullKey = `${API_KEY_PREFIX}${body}`;
  // prefix shown to users: cmail_ + first 6 chars of random body
  const prefix = `${API_KEY_PREFIX}${body.slice(0, 6)}`;
  return { fullKey, prefix };
}

export async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (!token.startsWith(API_KEY_PREFIX)) return null;
  return token;
}

export async function resolveUserFromApiKey(
  db: Variables["db"],
  token: string
): Promise<{ id: string; email: string; name: string; role: string | null } | null> {
  const hash = await hashApiKey(token);
  const rows = await db
    .select({
      key: apiKeys,
      user: users,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);

  if (rows.length === 0) return null;
  const { key, user } = rows[0];
  if (key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;

  // Fire-and-forget update; D1 awaits inline but it's a single statement.
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id));

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}
