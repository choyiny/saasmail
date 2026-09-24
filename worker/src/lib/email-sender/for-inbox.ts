import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { senderIdentities } from "../../db/sender-identities.schema";
import { GmailApiError } from "../gmail/api";
import { GoogleAuthError } from "../gmail/oauth";
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
 * This inbox is mapped to a Google mailbox and no token for it could be
 * resolved — so there is no honest way to send this reply.
 *
 * `code` is a classification, never free text: it reaches a log, and the
 * frame it comes from ends in a D1 UPDATE binding the plaintext access token
 * and the sealed refresh token.
 */
export class GmailSenderUnavailableError extends Error {
  constructor(
    readonly code: string,
    readonly inbox: string,
  ) {
    super(`gmail sender unavailable for ${inbox}: ${code}`);
    this.name = "GmailSenderUnavailableError";
  }
}

/**
 * Picks the sender for a reply from `fromAddress`: a GmailSender when that
 * address is a Gmail-mapped inbox with usable credentials, otherwise the
 * provider `createEmailSender` would already pick.
 *
 * Two outcomes that used to be one. "This inbox is not Gmail-mapped" — no
 * OAuth secrets, no identity row, `source: "cloudflare"`, or a null
 * `gmail_account_id` — still falls back quietly, because the configured
 * provider IS the right transport for it.
 *
 * "This inbox IS Gmail-mapped and we could not get a token" throws. Catching
 * it and falling back meant one failed HTTPS request to Google silently
 * rerouted a reply: on a Gmail-only install `createEmailSender` is
 * `NoopSender`, so the outbox marked the row "failed" while `replyToEmail`
 * returned ok, the route answered 201, and the composer cleared the draft and
 * closed — nothing sent and the user told it was. On an install that does
 * have Resend or Postmark it is worse: the reply goes out from a Workspace
 * address through a provider that domain's SPF/DKIM does not authorise,
 * failing DMARC, and the outbox retries it every 15 minutes. That is exactly
 * what `send-email.ts` forbids in the comment above its Gmail branch, and the
 * guard there could not see it because the substitution happened up here.
 *
 * The caller turns this into the same 502-and-preserve-the-draft outcome a
 * failed Gmail reply already gets.
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
    // A code, not the message: `getAccessToken`'s last statement binds the
    // access token and the sealed refresh token, and a D1 error carries its
    // bound parameters.
    const code =
      e instanceof GoogleAuthError || e instanceof GmailApiError
        ? e.code
        : "token_unavailable";
    console.error(
      `[createSenderForInbox] ${fromAddress} is Gmail-mapped but no token could be resolved: ${code}. Refusing to send it through another transport.`,
    );
    throw new GmailSenderUnavailableError(code, fromAddress);
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
