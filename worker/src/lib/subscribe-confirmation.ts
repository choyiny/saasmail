import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { emailTemplates } from "../db/email-templates.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createEmailSender } from "./email-sender";
import { formatFromAddress } from "./format-from-address";
import { interpolate } from "./interpolate";
import { generateMessageId } from "./message-id";
import { sendWithSuppressionCheck } from "./send";
import { signPayload } from "./signed-token";

/** Confirmation links expire after 48 hours. */
export const CONFIRM_TOKEN_TTL_SECONDS = 48 * 3600;

/**
 * Built-in confirmation email, used when a list sets no
 * `confirmationTemplateSlug`. Having a default in code is what lets an operator
 * switch on double opt-in without first authoring a template.
 */
const DEFAULT_CONFIRMATION_SUBJECT = "Please confirm your subscription";
const DEFAULT_CONFIRMATION_HTML = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.5;color:#111">
  <p>Thanks for signing up to <strong>{{list_name}}</strong>.</p>
  <p>Please confirm your subscription so we know this address is really yours:</p>
  <p><a href="{{confirm_url}}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Confirm subscription</a></p>
  <p style="color:#555;font-size:13px">If the button doesn't work, paste this into your browser:<br>{{confirm_url}}</p>
  <p style="color:#555;font-size:13px">This link expires in 48 hours. If you didn't request this, ignore this email — nothing will happen without your confirmation.</p>
</body></html>`;

export function buildConfirmUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/subscribe/confirm/${encodeURIComponent(token)}`;
}

export async function signConfirmToken(
  opts: { formId: string; listId: string; contactId: string },
  secret: string,
  now: number,
): Promise<string> {
  return signPayload(
    {
      v: 1,
      f: opts.formId,
      l: opts.listId,
      c: opts.contactId,
      exp: now + CONFIRM_TOKEN_TTL_SECONDS,
    },
    secret,
    "subscribe-confirm",
  );
}

export type ConfirmTokenClaims = {
  formId: string;
  listId: string;
  contactId: string;
};

export function readConfirmClaims(
  payload: Record<string, unknown>,
): ConfirmTokenClaims | null {
  const { f, l, c, v } = payload as Record<string, unknown>;
  if (v !== 1) return null;
  if (typeof f !== "string" || typeof l !== "string" || typeof c !== "string") {
    return null;
  }
  return { formId: f, listId: l, contactId: c };
}

/**
 * Pick the confirmation template and render it.
 *
 * Split out from the send so it can be tested without a mail provider: the
 * template-selection fallbacks are the part with real behaviour, and the
 * provider call is not exercisable in the test harness.
 *
 * A configured-but-missing template falls back to the built-in rather than
 * failing the submission — the subscriber did nothing wrong, and a membership
 * stuck at `pending` forever is worse than a generic-looking email.
 */
export async function buildConfirmationContent(
  db: DrizzleD1Database<any>,
  opts: { listName: string; confirmUrl: string; templateSlug: string | null },
): Promise<{ subject: string; html: string }> {
  let subject = DEFAULT_CONFIRMATION_SUBJECT;
  let html = DEFAULT_CONFIRMATION_HTML;

  if (opts.templateSlug) {
    const rows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, opts.templateSlug))
      .limit(1);
    if (rows[0]) {
      subject = rows[0].subject;
      html = rows[0].bodyHtml;
    }
  }

  const vars = { confirm_url: opts.confirmUrl, list_name: opts.listName };
  return {
    // The subject is plain text, so escaping would leak entities into it; the
    // HTML body keeps interpolate's default escaping.
    subject: interpolate(subject, vars, { escape: false }),
    html: interpolate(html, vars),
  };
}

/**
 * Send the opt-in confirmation.
 *
 * Deliberately *not* routed through `lib/send-email.ts`: that helper creates a
 * `people` row for the recipient, which would put every form submission —
 * including unconfirmed and abusive ones — into the CRM contact list. This is
 * the pollution the separate `contacts` table exists to prevent.
 *
 * Sent as non-transactional so the global suppression list is honoured. Someone
 * who previously unsubscribed everywhere should not receive mail just because a
 * third party typed their address into a form; that is the same reasoning that
 * makes double opt-in necessary in the first place.
 *
 * A `sent_emails` row is written with `personId: null` so the send is auditable
 * without manufacturing a correspondent.
 */
export async function sendConfirmationEmail(opts: {
  db: DrizzleD1Database<any>;
  env: CloudflareBindings;
  to: string;
  fromAddress: string;
  listName: string;
  confirmUrl: string;
  templateSlug: string | null;
}): Promise<{ sent: boolean }> {
  const { db, env, to, fromAddress, listName, confirmUrl, templateSlug } = opts;

  const { subject: renderedSubject, html: renderedHtml } =
    await buildConfirmationContent(db, { listName, confirmUrl, templateSlug });

  const sender = createEmailSender(env);
  const from = await formatFromAddress(db, fromAddress);
  const messageId = generateMessageId(fromAddress);
  const now = Math.floor(Date.now() / 1000);

  const result = await sendWithSuppressionCheck({
    db,
    env,
    sender,
    from,
    to,
    subject: renderedSubject,
    html: renderedHtml,
    headers: { "Message-ID": messageId },
    transactional: false,
  });

  if (result.delivered.length === 0) return { sent: false };

  await db.insert(sentEmails).values({
    id: nanoid(),
    // Never a people row for a subscriber — see the note above.
    personId: null,
    fromAddress,
    toAddress: to,
    subject: renderedSubject,
    bodyHtml: result.renderedHtml ?? renderedHtml,
    bodyText: result.renderedText ?? null,
    inReplyTo: null,
    messageId,
    resendId: result.result?.id ?? null,
    status: "sent",
    cc: null,
    // A confirmation is not correspondence; keeping it out of the conversation
    // view is the same call made for campaign sends.
    conversationId: null,
    sentAt: now,
    createdAt: now,
  });

  return { sent: true };
}
