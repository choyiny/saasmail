import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { senderIdentities } from "../../db/sender-identities.schema";
import { GmailApiError } from "../gmail/api";
import { GoogleAuthError } from "../gmail/oauth";
import { getAccessToken, invalidateAccessToken } from "../gmail/token";
import { createEmailSender } from "./index";
import {
  OutlookSender,
  OUTLOOK_MAX_ATTACHMENT_BYTES,
} from "./providers/outlook";
import {
  getOutlookAccessToken,
  invalidateOutlookAccessToken,
  outlookAuthConfig,
} from "../outlook/token";
import { MicrosoftAuthError } from "../outlook/oauth";
import { GraphApiError } from "../outlook/api";
import { gmailAuthConfig } from "../gmail/sync";
import { GmailSender, GMAIL_MAX_ATTACHMENT_BYTES } from "./providers/gmail";
import type { EmailSender } from "./types";

type ForInboxEnv = CloudflareBindings & {
  RESEND_API_KEY?: string;
  EMAIL?: SendEmail;
  BAVIMAIL_API_KEY?: string;
  BAVIMAIL_ALIAS_ID?: string;
  POSTMARK_API_KEY?: string;
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
    /** The same refusal applies to an Outlook-mapped inbox. */
    readonly provider: "gmail" | "outlook" = "gmail",
  ) {
    super(`${provider} sender unavailable for ${inbox}: ${code}`);
    this.name = "GmailSenderUnavailableError";
  }
}

/**
 * Picks the sender for a reply from `fromAddress`: a GmailSender when that
 * address is a Gmail-mapped inbox with usable credentials, otherwise the
 * provider `createEmailSender` would already pick.
 *
 * Two outcomes that used to be one. "This inbox is not mapped" — no
 * identity row, or `source: "cloudflare"` — uses the configured provider,
 * because that IS the right transport for it.
 *
 * "This inbox IS mapped and we could not get a token" throws, and so does a
 * mapped inbox whose OAuth configuration is missing or cannot be decrypted:
 * the mapping is read before the credentials. Catching
 * it and falling back meant one failed HTTPS request to Google silently
 * rerouted a reply: on a Gmail-only install `createEmailSender` is
 * `NoopSender`, so the outbox marked the row "failed" while `replyToEmail`
 * returned ok, the route answered 201, and the composer cleared the draft and
 * closed — nothing sent and the user told it was. On an install that does
 * have Resend or Postmark it is worse: the reply goes out from a Workspace
 * address through a provider that domain's SPF/DKIM does not authorise,
 * failing DMARC, and the outbox retries it every hour. That is exactly
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
  // The mapping first, the credentials second: an inbox mapped to a mailbox
  // goes out through that mailbox or not at all, whatever is missing.
  const mapping = await inboxMappingOf(db, fromAddress);
  if (!mapping) return createEmailSender(env);
  const { provider } = mapping;
  try {
    const sender =
      provider === "gmail"
        ? await tryGmailSender(db, env, mapping.accountId)
        : await tryOutlookSender(db, env, mapping.accountId);
    if (sender) return sender;
  } catch (e) {
    if (e instanceof GmailSenderUnavailableError) throw e;
    // A code, not the message: `getAccessToken`'s last statement binds the
    // access token and the sealed refresh token, and a D1 error carries its
    // bound parameters.
    const code =
      e instanceof GoogleAuthError ||
      e instanceof GmailApiError ||
      e instanceof MicrosoftAuthError ||
      e instanceof GraphApiError
        ? e.code
        : "token_unavailable";
    console.error(
      `[createSenderForInbox] ${fromAddress} is ${provider}-mapped but no token could be resolved: ${code}. Refusing to send it through another transport.`,
    );
    throw new GmailSenderUnavailableError(code, fromAddress, provider);
  }
  // Mapped, but the OAuth client is not set up, or its secret or
  // TOKEN_ENCRYPTION_KEY is missing or cannot decrypt it.
  console.error(
    `[createSenderForInbox] ${fromAddress} is ${provider}-mapped but the ${provider === "gmail" ? "Google" : "Microsoft"} OAuth configuration is unusable. Refusing to send it through another transport.`,
  );
  throw new GmailSenderUnavailableError(
    "not_configured",
    fromAddress,
    provider,
  );
}

/**
 * The mailbox `fromAddress` is mapped to, from its `sender_identities` row
 * alone (no credentials read), or null for an inbox the configured provider
 * sends. A mapping whose account id is missing still counts: such an inbox
 * must not leave through another transport either.
 */
export async function inboxMappingOf(
  db: DrizzleD1Database<typeof schema>,
  fromAddress: string,
): Promise<{ provider: "gmail" | "outlook"; accountId: string | null } | null> {
  // sender_identities.email is stored lowercased; every other lookup site
  // normalises before querying, and this must too, or a from-address that
  // merely differs in case/whitespace silently misses its mapping.
  const normalizedFrom = fromAddress.trim().toLowerCase();
  const [identity] = await db
    .select({
      source: senderIdentities.source,
      gmailAccountId: senderIdentities.gmailAccountId,
      outlookAccountId: senderIdentities.outlookAccountId,
    })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, normalizedFrom))
    .limit(1);
  if (identity?.source === "gmail") {
    return { provider: "gmail", accountId: identity.gmailAccountId ?? null };
  }
  if (identity?.source === "outlook") {
    return {
      provider: "outlook",
      accountId: identity.outlookAccountId ?? null,
    };
  }
  return null;
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
    const mapping = await inboxMappingOf(db, fromAddress);
    if (mapping?.provider === "gmail") return GMAIL_MAX_ATTACHMENT_BYTES;
    if (mapping?.provider === "outlook") return OUTLOOK_MAX_ATTACHMENT_BYTES;
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
  accountId: string | null,
): Promise<GmailSender | null> {
  // Null: Google is not set up, or its secret cannot be decrypted.
  const cfg = await gmailAuthConfig(db, env);
  if (!cfg) return null;
  if (!accountId) throw new Error("unknown gmail account");

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

async function tryOutlookSender(
  db: DrizzleD1Database<typeof schema>,
  env: ForInboxEnv,
  accountId: string | null,
): Promise<OutlookSender | null> {
  const cfg = await outlookAuthConfig(db, env);
  if (!cfg) return null;
  if (!accountId) throw new Error("unknown outlook account");
  // Resolving the token now is what surfaces a revoked grant here, where the
  // caller refuses the send, instead of mid-request.
  const accessToken = await getOutlookAccessToken(db, accountId, cfg);
  return new OutlookSender(accessToken, undefined, {
    accountId,
    reauthorize: async () => {
      await invalidateOutlookAccessToken(db, accountId);
      return getOutlookAccessToken(db, accountId, cfg);
    },
  });
}
