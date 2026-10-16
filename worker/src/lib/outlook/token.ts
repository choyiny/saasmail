import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { outlookAccounts } from "../../db/outlook-accounts.schema";
import { decryptSecret, encryptSecret } from "../crypto";
import { loadProviderConfig } from "../oauth-providers";
import { MicrosoftAuthError, refreshAccessToken } from "./oauth";

const EXPIRY_MARGIN_SECONDS = 60;

export type OutlookAuthConfig = {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  /** Null means "common": any work, school or personal account. */
  tenant: string | null;
};

/**
 * The Microsoft OAuth app and encryption key, or null when Outlook is not
 * set up. Entered under Inboxes → Microsoft settings; there is no env-var
 * fallback, since Outlook never had one.
 */
export async function outlookAuthConfig(
  db: DrizzleD1Database<typeof schema>,
  env: unknown,
): Promise<OutlookAuthConfig | null> {
  const cfg = await loadProviderConfig(db, env, "microsoft");
  if (!cfg) return null;
  return {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    encryptionKey: cfg.encryptionKey,
    tenant: cfg.tenant,
  };
}

/** Drop the cached access token so the next call must refresh. */
export async function invalidateOutlookAccessToken(
  db: DrizzleD1Database<typeof schema>,
  accountId: string,
): Promise<void> {
  await db
    .update(outlookAccounts)
    .set({
      accessToken: null,
      expiresAt: null,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(outlookAccounts.id, accountId));
}

/**
 * A live Graph access token for the account, refreshing it when the cached
 * one is within a minute of expiry.
 *
 * Stores the refresh token Microsoft hands back, which usually differs from
 * the one spent: Microsoft rotates them, and an old one stops working.
 *
 * Throws MicrosoftAuthError when the refresh is refused, after recording the
 * code as `lastError` — `invalid_grant` there means the mailbox needs a
 * reconnect.
 */
export async function getOutlookAccessToken(
  db: DrizzleD1Database<typeof schema>,
  accountId: string,
  cfg: OutlookAuthConfig,
): Promise<string> {
  const [account] = await db
    .select()
    .from(outlookAccounts)
    .where(eq(outlookAccounts.id, accountId));
  if (!account) throw new Error(`unknown outlook account: ${accountId}`);

  const now = Math.floor(Date.now() / 1000);
  if (
    account.accessToken &&
    account.expiresAt &&
    account.expiresAt - now > EXPIRY_MARGIN_SECONDS
  ) {
    return account.accessToken;
  }

  const refreshToken = await decryptSecret(
    account.refreshTokenEncrypted,
    cfg.encryptionKey,
  );

  let tokens;
  try {
    tokens = await refreshAccessToken({
      refreshToken,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      tenant: cfg.tenant,
    });
  } catch (err) {
    const code =
      err instanceof MicrosoftAuthError ? err.code : "refresh_failed";
    await db
      .update(outlookAccounts)
      .set({ lastError: code, updatedAt: now })
      .where(eq(outlookAccounts.id, accountId));
    throw err;
  }

  const sealed = tokens.refreshToken
    ? await encryptSecret(tokens.refreshToken, cfg.encryptionKey)
    : account.refreshTokenEncrypted;

  await db
    .update(outlookAccounts)
    .set({
      accessToken: tokens.accessToken,
      expiresAt: now + tokens.expiresIn,
      refreshTokenEncrypted: sealed,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(outlookAccounts.id, accountId));

  return tokens.accessToken;
}
