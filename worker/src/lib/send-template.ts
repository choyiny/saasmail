import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { emailTemplates } from "../db/email-templates.schema";
import { people } from "../db/people.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createEmailSender } from "./email-sender";
import { formatFromAddress } from "./format-from-address";
import { assertInboxAllowed, type AllowedInboxes } from "./inbox-permissions";
import { renderTemplate } from "./interpolate";
import { generateMessageId } from "./message-id";
import { sendViaOutbox, type OutboxOutcome } from "./outbox";

export type SendTemplateParams = {
  db: DrizzleD1Database<any>;
  env: CloudflareBindings;
  slug: string;
  to: string;
  fromAddress: string;
  variables: Record<string, string>;
  allowed: AllowedInboxes;
};

export type SendTemplateSuccess = {
  ok: true;
  id: string | null;
  resendId: string | null;
  status: OutboxOutcome;
  delivered: string[];
  suppressed: string[];
};

export type SendTemplateFailure =
  | { ok: false; code: "TEMPLATE_NOT_FOUND"; message: string }
  | {
      ok: false;
      code: "MISSING_VARIABLES";
      message: string;
      missingVariables: string[];
      requiredVariables: string[];
    };

export type SendTemplateResult = SendTemplateSuccess | SendTemplateFailure;

/**
 * Render an email template and send it via the outbox.
 *
 * Failure modes callers must surface are returned rather than thrown so this
 * can back both the HTTP route and the MCP tool; only the inbox permission
 * check throws (HTTPException), matching the routers' existing behavior.
 */
export async function sendTemplate(
  params: SendTemplateParams,
): Promise<SendTemplateResult> {
  const { db, env, slug, variables, allowed } = params;

  // Canonicalize before authorizing AND before storing, as the send routes do.
  // assertInboxAllowed folds case, so `Support@x.com` passes — but persisting
  // it verbatim produced a sent_emails row its own sender could not read back,
  // since the read paths match against the lowercased grant list.
  const fromAddress = params.fromAddress.trim().toLowerCase();
  const to = params.to.trim().toLowerCase();

  assertInboxAllowed(allowed, fromAddress);

  // Look up template
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);

  if (rows.length === 0) {
    return {
      ok: false,
      code: "TEMPLATE_NOT_FOUND",
      message: "Template not found",
    };
  }

  const rendered = renderTemplate(rows[0], variables);
  if (!rendered.ok) {
    return {
      ok: false,
      code: "MISSING_VARIABLES",
      message: "Missing required template variables",
      missingVariables: rendered.missingVariables,
      requiredVariables: rendered.requiredVariables,
    };
  }

  const renderedSubject = rendered.subject;
  const renderedHtml = rendered.bodyHtml;

  const sender = createEmailSender(env);
  const id = nanoid();
  const messageId = generateMessageId(fromAddress);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const { outcome, send: sendResult } = await sendViaOutbox({
    db,
    env,
    sender,
    sentEmailId: id,
    fromAddress,
    from: formattedFrom,
    to,
    subject: renderedSubject,
    html: renderedHtml,
    headers: { "Message-ID": messageId },
  });

  // Recipient is on the suppression list — no transport call, no sent_emails
  // write. Tell the admin caller so the UI can surface "suppressed".
  if (outcome === "suppressed") {
    console.log(
      "[template-send] recipient suppressed",
      JSON.stringify({ from: fromAddress, suppressed: sendResult.suppressed }),
    );
    return {
      ok: true,
      id: null,
      resendId: null,
      status: "suppressed",
      delivered: [],
      suppressed: sendResult.suppressed,
    };
  }

  const result = sendResult.result!;

  // Find person if they exist
  const existingPerson = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, to))
    .limit(1);

  const personId = existingPerson[0]?.id ?? null;

  // Store sent email
  const now = Math.floor(Date.now() / 1000);
  await db.insert(sentEmails).values({
    id,
    personId,
    fromAddress,
    toAddress: to,
    subject: renderedSubject,
    // Record what was on the wire (helper may have interpolated
    // {{unsubscribe_url}} or auto-appended a footer), not the pre-helper
    // template render.
    bodyHtml: sendResult.renderedHtml ?? renderedHtml,
    bodyText: sendResult.renderedText ?? null,
    messageId,
    resendId: result.id,
    status: outcome,
    sentAt: now,
    createdAt: now,
  });

  return {
    ok: true,
    id,
    resendId: result.id,
    status: outcome,
    delivered: sendResult.delivered,
    suppressed: sendResult.suppressed,
  };
}
