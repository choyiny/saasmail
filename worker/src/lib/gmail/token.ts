import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { gmailAccounts } from "../../db/gmail-accounts.schema";
import { decryptSecret, encryptSecret } from "../crypto";
import { GoogleAuthError, refreshAccessToken } from "./oauth";

/**
 * Refresh this far ahead of expiry so a token cannot die mid-sync.
 */
const EXPIRY_MARGIN_SECONDS = 60;

export type GmailAuthConfig = {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
};

export async function getAccessToken(
  db: DrizzleD1Database<any>,
  accountId: string,
  cfg: GmailAuthConfig,
): Promise<string> {
  const [account] = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, accountId));

  if (!account) throw new Error(`unknown gmail account: ${accountId}`);

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
    });
  } catch (err) {
    const code = err instanceof GoogleAuthError ? err.code : "refresh_failed";
    await db
      .update(gmailAccounts)
      .set({ lastError: code, updatedAt: now })
      .where(eq(gmailAccounts.id, accountId));
    throw err;
  }

  // Google usually omits refresh_token on refresh; when it does rotate one,
  // store the new value or the next refresh fails.
  const sealed = tokens.refreshToken
    ? await encryptSecret(tokens.refreshToken, cfg.encryptionKey)
    : account.refreshTokenEncrypted;

  await db
    .update(gmailAccounts)
    .set({
      accessToken: tokens.accessToken,
      expiresAt: now + tokens.expiresIn,
      refreshTokenEncrypted: sealed,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(gmailAccounts.id, accountId));

  return tokens.accessToken;
}
