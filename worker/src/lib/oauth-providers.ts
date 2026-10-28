import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { appSettings } from "../db/app-settings.schema";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * OAuth app settings for the mailbox providers, kept in `app_settings` so an
 * admin enters them on the Inboxes page instead of with `wrangler secret put`.
 *
 * One row per provider, keyed `oauth_provider:<provider>`, holding JSON:
 * the client id in the clear and the client secret SEALED with
 * TOKEN_ENCRYPTION_KEY — the one secret that stays in wrangler, because a key
 * stored next to what it encrypts protects nothing. The secret is never sent
 * back to the browser; the API only says whether one is set.
 *
 * Google's settings could only come from env vars before this, so those still
 * work: a stored row wins, and `GOOGLE_OAUTH_CLIENT_ID` /
 * `GOOGLE_OAUTH_CLIENT_SECRET` are the fallback when there is none.
 */

export const OAUTH_PROVIDERS = ["google", "microsoft"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Everything a token refresh or a consent URL needs. */
export type ProviderConfig = {
  clientId: string;
  clientSecret: string;
  /** TOKEN_ENCRYPTION_KEY: seals refresh tokens and signs OAuth state. */
  encryptionKey: string;
  /**
   * Microsoft only: the directory to sign in against. Null means "common" —
   * any work, school or personal Microsoft account.
   */
  tenant: string | null;
  /** Where the settings came from, so the UI can say. */
  source: "database" | "env";
};

type ProviderEnv = {
  TOKEN_ENCRYPTION_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
};

type StoredValue = {
  clientId: string;
  clientSecretSealed: string;
  tenant?: string | null;
};

const settingsKey = (provider: OAuthProvider) => `oauth_provider:${provider}`;

/** TOKEN_ENCRYPTION_KEY, or null when the install has not set one. */
export function encryptionKeyOf(env: unknown): string | null {
  return (env as ProviderEnv).TOKEN_ENCRYPTION_KEY || null;
}

async function readStored(
  db: DrizzleD1Database<any>,
  provider: OAuthProvider,
): Promise<{
  value: StoredValue;
  updatedAt: number;
  updatedBy: string | null;
} | null> {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, settingsKey(provider)))
    .limit(1);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<StoredValue>;
    if (
      typeof parsed.clientId !== "string" ||
      typeof parsed.clientSecretSealed !== "string"
    ) {
      return null;
    }
    return {
      value: {
        clientId: parsed.clientId,
        clientSecretSealed: parsed.clientSecretSealed,
        tenant: typeof parsed.tenant === "string" ? parsed.tenant : null,
      },
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  } catch {
    return null;
  }
}

/**
 * The provider's settings, or null when it is not configured — no stored
 * settings and no env fallback, or no TOKEN_ENCRYPTION_KEY to use them with.
 *
 * A stored secret that will not decrypt (TOKEN_ENCRYPTION_KEY changed since
 * it was saved) counts as unconfigured and is logged: the fix is to enter
 * the secret again, and falling back to env vars would hide that.
 */
export async function loadProviderConfig(
  db: DrizzleD1Database<any>,
  env: unknown,
  provider: OAuthProvider,
): Promise<ProviderConfig | null> {
  const encryptionKey = encryptionKeyOf(env);
  if (!encryptionKey) return null;

  const stored = await readStored(db, provider);
  if (stored) {
    try {
      const clientSecret = await decryptSecret(
        stored.value.clientSecretSealed,
        encryptionKey,
      );
      return {
        clientId: stored.value.clientId,
        clientSecret,
        encryptionKey,
        tenant: stored.value.tenant ?? null,
        source: "database",
      };
    } catch {
      console.error(
        `[oauth-providers] the stored ${provider} client secret cannot be decrypted — was TOKEN_ENCRYPTION_KEY changed? Enter it again on the Inboxes page.`,
      );
      return null;
    }
  }

  const e = env as ProviderEnv;
  if (
    provider === "google" &&
    e.GOOGLE_OAUTH_CLIENT_ID &&
    e.GOOGLE_OAUTH_CLIENT_SECRET
  ) {
    return {
      clientId: e.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET,
      encryptionKey,
      tenant: null,
      source: "env",
    };
  }
  return null;
}

/** What the admin UI shows for one provider. Never includes the secret. */
export type ProviderDescription = {
  provider: OAuthProvider;
  configured: boolean;
  source: "database" | "env" | null;
  clientId: string | null;
  hasClientSecret: boolean;
  tenant: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
};

export async function describeProvider(
  db: DrizzleD1Database<any>,
  env: unknown,
  provider: OAuthProvider,
): Promise<ProviderDescription> {
  const stored = await readStored(db, provider);
  const loaded = await loadProviderConfig(db, env, provider);
  if (stored) {
    return {
      provider,
      configured: loaded !== null,
      source: "database",
      clientId: stored.value.clientId,
      hasClientSecret: true,
      tenant: stored.value.tenant ?? null,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    };
  }
  return {
    provider,
    configured: loaded !== null,
    source: loaded?.source ?? null,
    clientId: loaded?.clientId ?? null,
    hasClientSecret: loaded !== null,
    tenant: null,
    updatedAt: null,
    updatedBy: null,
  };
}

export class ProviderConfigError extends Error {}

/**
 * Store a provider's settings. `clientSecret` may be omitted to keep the one
 * already stored (an admin changing only the tenant should not have to paste
 * the secret again) — but there has to be one.
 */
export async function saveProviderConfig(
  db: DrizzleD1Database<any>,
  env: unknown,
  provider: OAuthProvider,
  input: { clientId: string; clientSecret?: string; tenant?: string | null },
  updatedBy: string | null,
): Promise<void> {
  const encryptionKey = encryptionKeyOf(env);
  if (!encryptionKey) {
    throw new ProviderConfigError(
      "TOKEN_ENCRYPTION_KEY is not set, so secrets cannot be stored. Set it with `wrangler secret put TOKEN_ENCRYPTION_KEY` (32 random bytes, base64) and redeploy.",
    );
  }

  let clientSecretSealed: string;
  if (input.clientSecret) {
    clientSecretSealed = await encryptSecret(input.clientSecret, encryptionKey);
  } else {
    const stored = await readStored(db, provider);
    if (!stored) {
      throw new ProviderConfigError("A client secret is required.");
    }
    clientSecretSealed = stored.value.clientSecretSealed;
  }

  const value: StoredValue = {
    clientId: input.clientId.trim(),
    clientSecretSealed,
    tenant: provider === "microsoft" ? input.tenant?.trim() || null : undefined,
  };
  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(appSettings)
    .values({
      key: settingsKey(provider),
      value: JSON.stringify(value),
      updatedAt: now,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: JSON.stringify(value), updatedAt: now, updatedBy },
    });
}

/** Remove the stored settings. Google falls back to env vars, if any. */
export async function clearProviderConfig(
  db: DrizzleD1Database<any>,
  provider: OAuthProvider,
): Promise<void> {
  await db
    .delete(appSettings)
    .where(eq(appSettings.key, settingsKey(provider)));
}
