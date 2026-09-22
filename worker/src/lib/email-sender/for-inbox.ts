import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { senderIdentities } from "../../db/sender-identities.schema";
import { getAccessToken, invalidateAccessToken } from "../gmail/token";
import { createEmailSender } from "./index";
import { GmailSender, GMAIL_MAX_ATTACHMENT_BYTES } from "./providers/gmail";
import type { EmailSender } from "./types";

type ForInboxEnv = CloudflareBindings & {
  RESEND_API_KEY?: string;
  EMAIL?: SendEmail;
  BAVIMAIL_API_KEY?: string;
  BAVIMAIL_ALIAS_ID?: string;
  POSTMARK_API_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
};

/**
 * Picks the sender for a reply from `fromAddress`: a GmailSender when that
 * address is a Gmail-mapped inbox with usable credentials, otherwise the
 * provider `createEmailSender` would already pick.
 *
 * This sits behind the reply button, so it must NEVER throw. Every failure —
 * Gmail integration not configured, an unmapped address, a dangling
 * `gmailAccountId` (there is no foreign-key check on that column), or a
 * revoked Google grant — falls back to `createEmailSender(env)` and logs,
 * rather than breaking replying. A degraded send path beats a broken one.
 */
export async function createSenderForInbox(
  db: DrizzleD1Database<typeof schema>,
  env: ForInboxEnv,
  fromAddress: string,
): Promise<EmailSender> {
  try {
    const gmailSender = await tryGmailSender(db, env, fromAddress);
    if (gmailSender) return gmailSender;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[createSenderForInbox] falling back to the configured provider for ${fromAddress}:`,
      message,
    );
  }
  return createEmailSender(env);
}

/**
 * The Gmail account id `fromAddress` sends through, or null when this reply
 * will not go out through Gmail at all — no OAuth secrets, not a Gmail-mapped
 * identity, or no account behind the mapping.
 *
 * Shared by the sender and the attachment-budget lookup so the two can never
 * disagree about which transport a reply is headed for.
 */
async function resolveGmailAccountId(
  db: DrizzleD1Database<typeof schema>,
  env: ForInboxEnv,
  fromAddress: string,
): Promise<string | null> {
  if (
    !env.GOOGLE_OAUTH_CLIENT_ID ||
    !env.GOOGLE_OAUTH_CLIENT_SECRET ||
    !env.TOKEN_ENCRYPTION_KEY
  ) {
    console.error(
      "[createSenderForInbox] Gmail integration is not configured (missing OAuth secrets); falling back to the configured provider",
    );
    return null;
  }

  // sender_identities.email is stored lowercased; every other lookup site
  // normalises before querying (see admin-inboxes-router.ts, email-handler.ts,
  // send-email.ts, send-template.ts, route-inbox.ts) and this must too, or a
  // from-address that merely differs in case/whitespace silently misses its
  // Gmail mapping and falls back with no error anywhere.
  const normalizedFrom = fromAddress.trim().toLowerCase();

  const [identity] = await db
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.email, normalizedFrom));
  if (!identity || identity.source !== "gmail" || !identity.gmailAccountId) {
    console.error(
      `[createSenderForInbox] ${normalizedFrom} is not a Gmail-mapped inbox; falling back to the configured provider`,
    );
    return null;
  }
  return identity.gmailAccountId;
}

/**
 * The attachment budget for a reply from `fromAddress`: the limit of the
 * sender that will actually carry it.
 *
 * Sizing a reply with `createEmailSender(env)` instead — the *configured*
 * provider — never asks Gmail. On a Gmail-only install, which is the natural
 * deployment for this feature, that is `NoopSender` and its budget is 0, so
 * every attachment on a Gmail reply 413s while Gmail would have taken it.
 *
 * Decided on the mapping alone, with no token resolved: this runs during
 * multipart parsing, before the inbox permission check and before any send,
 * and must not touch Google to answer a question about byte counts.
 */
export async function maxAttachmentBytesForInbox(
  db: DrizzleD1Database<typeof schema>,
  env: ForInboxEnv,
  fromAddress: string,
): Promise<number> {
  try {
    if (await resolveGmailAccountId(db, env, fromAddress)) {
      return GMAIL_MAX_ATTACHMENT_BYTES;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[maxAttachmentBytesForInbox] falling back to the configured provider's limit for ${fromAddress}:`,
      message,
    );
  }
  return createEmailSender(env).maxAttachmentBytes();
}

/**
 * Resolves the identity row, then the account, then the token — returning
 * null (never throwing to its own caller in a way that escapes the outer
 * try/catch) whenever any step comes up short.
 */
async function tryGmailSender(
  db: DrizzleD1Database<typeof schema>,
  env: ForInboxEnv,
  fromAddress: string,
): Promise<GmailSender | null> {
  const accountId = await resolveGmailAccountId(db, env, fromAddress);
  if (!accountId) return null;

  const clientId = env.GOOGLE_OAUTH_CLIENT_ID!;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET!;
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY!;
  const cfg = { clientId, clientSecret, encryptionKey };

  // Resolve a token now — this is what surfaces a dangling gmailAccountId
  // (getAccessToken throws "unknown gmail account") or a grant revoked
  // BEFORE the cached token expired (getAccessToken throws GoogleAuthError on
  // invalid_grant) here, where the fallback below catches it.
  //
  // It cannot see a grant revoked while the cached token is still inside its
  // TTL: no refresh happens, so there is nothing to fail. That case is caught
  // at the other end, by the 401 handling inside GmailSender — which is what
  // `reauthorize` below exists for.
  //
  // The resolved token is handed to the sender rather than re-resolved by it:
  // one reply, one token lookup.
  const accessToken = await getAccessToken(db, accountId, cfg);

  return new GmailSender(accessToken, undefined, {
    accountId,
    reauthorize: async () => {
      await invalidateAccessToken(db, accountId);
      return getAccessToken(db, accountId, cfg);
    },
  });
}
