import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { createDb } from "./db/client";
import type { schema } from "./db/schema";
import { emails } from "./db/emails.schema";
import { inboxPermissions } from "./db/inbox-permissions.schema";
import { senderIdentities } from "./db/sender-identities.schema";
import { users } from "./db/auth.schema";
import { parseEmail } from "./lib/email-parser";
import type { ParsedEmail } from "./lib/email-parser";
import {
  MAX_ATTACHMENTS,
  domainsOf,
  storeReceivedMessage,
} from "./lib/inbound/store-received";
import { splitSubaddress } from "./lib/inbound/subaddress";
import { isBlocked } from "./lib/blocklist";
import { cancelSequencesForPerson } from "./lib/cancel-sequence";
import {
  MAX_ADMIN_FANOUT,
  computeFanoutTargets,
} from "./lib/notification-fanout";
import { sanitizeFilename } from "./lib/sanitize-filename";
import { buildWebhookPayload, deliverWebhook } from "./lib/webhook-delivery";
import { forwardInbound } from "./lib/inbound-forward";
import { wakeConversation } from "./lib/messages/conversation-state";
import { setSystemSpamState } from "./lib/messages/state";
import { selectModel } from "./lib/agent/provider";
import { isAutomatedInbound } from "./lib/automated-inbound";
import {
  recordRuleMatch,
  rejectionOf,
  runMatchedRules,
  selectMatchingRules,
  type MatchedRule,
} from "./lib/rules/evaluate";
import type { RuleMessage } from "./lib/rules/match";
import { scoreInbound } from "./lib/spam/filter";
import { ruleActor } from "./lib/audit/actors";
import { runWithAudit } from "./lib/audit/context";
import {
  UNKNOWN_RECIPIENT_REASON,
  hasInboxMembers,
  recordInboundRejection,
  rejectsUnknownRecipients,
} from "./lib/inbound-rejection";
import { messagePreview } from "./lib/push-preview";

export { isAutomatedInbound } from "./lib/automated-inbound";

export function shouldEnqueueSuggestedReply(options: {
  agentAutodraft: number | null | undefined;
  autoFiledSpam: boolean;
  modelConfigured: boolean;
  headers: Record<string, string>;
  senderAddress: string;
}): boolean {
  return (
    options.agentAutodraft === 1 &&
    !options.autoFiledSpam &&
    options.modelConfigured &&
    !isAutomatedInbound(options.headers, options.senderAddress)
  );
}

/** What `ingestParsedEmail` did with a message. */
export type IngestOutcome =
  /** Refused: the live handler bounces it with `reason`. Nothing stored. */
  | { status: "rejected"; reason: string }
  /** From a blocked sender or domain: dropped silently, nothing stored. */
  | { status: "blocked" }
  /** Already in this inbox (same Message-ID): nothing stored. */
  | { status: "duplicate"; emailId: string }
  /** Stored, and every step after storage has run. */
  | { status: "stored"; emailId: string };

export type IngestOptions = {
  /**
   * Set when importing old mail (the Gmail backfill). The message is stored
   * already read, at its own `receivedAt`, and NONE of the live side effects
   * run: no push notification, no webhook, no forward, no sequence
   * cancellation. Replaying a year of those would page the team for
   * mail they have already handled, re-forward it all, and stop sequences
   * because of a reply someone sent weeks before they were enrolled.
   *
   * Stored the way the mail importer stores history (`source: "import"`):
   * no spam scoring, rules, suggested reply, conversation wake, audit,
   * realtime, push, webhook, forward or sequence cancellation.
   */
  historical?: { receivedAt: number };
  /** The synced mailbox's ids for the message, written with the row. */
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  outlookMessageId?: string | null;
};

/** Cloudflare Email Worker entry point. */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: CloudflareBindings,
  ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env);
  // The SMTP envelope recipient picks the inbox, not the MIME To (a Bcc
  // delivery names another address there).
  const parsed = await parseEmail(message);
  const outcome = await ingestParsedEmail(db, parsed, env, ctx);
  if (outcome.status === "rejected") message.setReject(outcome.reason);
}

/**
 * Stores an already-parsed inbound message in the inbox `parsed.to` names and
 * runs every step that follows: unknown-recipient and rule rejection,
 * blocklist, per-inbox dedupe, spam scoring, rules, suggested replies,
 * conversation wake, notifications, webhook, forwarding and sequence
 * cancellation.
 *
 * Source-agnostic: the Email Worker reaches it through `handleEmail`; a
 * mailbox sync calls it directly with a `ParsedEmail` built from the raw
 * message, setting `parsed.to` to the inbox it belongs in. A rejection is
 * returned, not sent: the caller decides how to refuse.
 */
export async function ingestParsedEmail(
  db: DrizzleD1Database<typeof schema>,
  parsed: ParsedEmail,
  env: CloudflareBindings,
  ctx: ExecutionContext,
  opts: IngestOptions = {},
): Promise<IngestOutcome> {
  const now = Math.floor(Date.now() / 1000);
  const historical = opts.historical ?? null;
  /** When the message arrived: now for live mail, its own time for imports. */
  const receivedAt = historical?.receivedAt ?? now;

  // Canonicalize inbox addresses to lowercase before storage so casing
  // variants of the same recipient don't fork into separate group-row
  // buckets (the grouped query keys by `(conversation_id, inbox)`, and
  // conversation_id is computed from lowercased inputs already — we
  // need the stored column to match).
  const envelopeRecipient = parsed.to.trim().toLowerCase();
  const fromAddressCanonical = parsed.from.address.trim().toLowerCase();

  // One scan of sender_identities serves four consumers: the unknown-recipient
  // check below, the "our domains" set, the forward destination for this
  // inbox, and the known-inbox loop guard in `forwardInbound`.
  const identityRows = await db
    .select({
      email: senderIdentities.email,
      displayName: senderIdentities.displayName,
      forwardTo: senderIdentities.forwardTo,
      spamThreshold: senderIdentities.spamThreshold,
      agentAutodraft: senderIdentities.agentAutodraft,
      threadingMode: senderIdentities.threadingMode,
      purpose: senderIdentities.purpose,
      testRetentionDays: senderIdentities.testRetentionDays,
    })
    .from(senderIdentities);
  const identityOf = (address: string) =>
    identityRows.find((row) => row.email.trim().toLowerCase() === address);

  // `local+detail@` belongs to the test inbox `local@` when no inbox has the
  // exact address (docs/inboxes.md, "Test inboxes"). Every other plus address
  // is an address of its own.
  let inboxAddress = envelopeRecipient;
  let recipientDetail: string | null = null;
  let inboxIdentity = identityOf(envelopeRecipient);
  if (!inboxIdentity) {
    const { base, detail } = splitSubaddress(envelopeRecipient);
    const baseIdentity = detail === null ? undefined : identityOf(base);
    if (
      baseIdentity?.purpose === "test" &&
      !(await hasInboxMembers(db, envelopeRecipient))
    ) {
      inboxAddress = base;
      recipientDetail = detail;
      inboxIdentity = baseIdentity;
    }
  }
  const recipientCanonical = inboxAddress;

  // Mail to an address that is not an inbox (no sender identity, no members)
  // is refused while the sender's server is still connected, when an admin
  // turned that on. Off, the catch-all stores mail to any address under the
  // routed domains.
  if (
    !inboxIdentity &&
    (await rejectsUnknownRecipients(db)) &&
    !(await hasInboxMembers(db, recipientCanonical))
  ) {
    // Recording the refusal is best effort: it must never stop the refusal.
    try {
      await recordInboundRejection(db, {
        from: fromAddressCanonical,
        recipient: recipientCanonical,
        subject: parsed.subject,
        messageId: parsed.messageId,
        reason: "unknown_recipient",
      });
    } catch (error) {
      console.warn("Failed to record an inbound rejection:", error);
    }
    console.log(
      `Rejected email from ${fromAddressCanonical} to ${recipientCanonical}: not an inbox`,
    );
    return { status: "rejected", reason: UNKNOWN_RECIPIENT_REASON };
  }

  // Drop mail from blocked senders/domains before any storage or side effects.
  if (await isBlocked(db, fromAddressCanonical)) {
    console.log(`Dropped blocked email from ${fromAddressCanonical}`);
    return { status: "blocked" };
  }

  // Deduplicate by Message-ID within this inbox: a redelivery is dropped, but a
  // message addressed to two of our inboxes is stored in each.
  if (parsed.messageId) {
    const existing = await db
      .select({ id: emails.id })
      .from(emails)
      .where(
        and(
          eq(emails.messageId, parsed.messageId),
          eq(emails.recipient, recipientCanonical),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      console.log(`Duplicate email with Message-ID: ${parsed.messageId}`);
      return { status: "duplicate", emailId: existing[0].id };
    }
  }

  // A test inbox stores its mail and does nothing else: no spam score, rules,
  // suggested reply, wake, notification, webhook, forward or sequence cancel.
  // It is Cloudflare-routed, so never historical.
  if (inboxIdentity?.purpose === "test") {
    const { emailId } = await storeReceivedMessage(db, env, {
      parsed,
      inbox: recipientCanonical,
      fromAddress: fromAddressCanonical,
      receivedAt: now,
      now,
      source: "inbound",
      ourDomains: domainsOf(identityRows.map((r) => r.email)),
      threadingMode: inboxIdentity.threadingMode,
      recipientDetail,
    });
    return { status: "stored", emailId };
  }

  const providerIds = {
    gmailMessageId: opts.gmailMessageId ?? null,
    gmailThreadId: opts.gmailThreadId ?? null,
    outlookMessageId: opts.outlookMessageId ?? null,
  };

  if (historical) {
    // History, stored as the mail importer stores it: read, at its own time,
    // and none of the live steps below.
    const { emailId } = await storeReceivedMessage(db, env, {
      parsed,
      inbox: recipientCanonical,
      fromAddress: fromAddressCanonical,
      receivedAt,
      now,
      source: "import",
      ourDomains: domainsOf(identityRows.map((r) => r.email)),
      threadingMode: inboxIdentity?.threadingMode ?? "relationship",
      ...providerIds,
    });
    return { status: "stored", emailId };
  }

  // The inbox's learning filter scores the message, when it is on and
  // trained; a rule acts on the score. Never fatal.
  let spamProbability: number | null = null;
  try {
    spamProbability = await scoreInbound(db, recipientCanonical, {
      fromAddress: fromAddressCanonical,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      hasAttachments: parsed.attachments.length > 0,
    });
  } catch (error) {
    console.warn("Failed to score inbound mail:", error);
  }

  // Which rules match is decided before storage: every condition reads the
  // parsed message only. A matching `reject` rule refuses the message here;
  // the other rules' actions run once it is stored.
  const ruleMessage: RuleMessage = {
    spamProbability,
    fromAddress: fromAddressCanonical,
    subject: parsed.subject,
    bodyText: parsed.bodyText,
    bodyHtml: parsed.bodyHtml,
    hasAttachments: parsed.attachments.length > 0,
    spamScore: parsed.spamScore,
    headers: parsed.headers,
  };
  let matchedRules: MatchedRule[] = [];
  try {
    matchedRules = await selectMatchingRules(db, {
      inbox: recipientCanonical,
      message: ruleMessage,
    });
  } catch (error) {
    console.warn("Failed to select inbound rules:", error);
  }
  const rejection = rejectionOf(matchedRules);
  if (rejection) {
    // Recording the refusal is best effort: it must never stop the refusal.
    try {
      await recordRuleMatch(db, rejection.rule.id, now);
      await runWithAudit(ruleActor(rejection.rule), () =>
        recordInboundRejection(db, {
          from: fromAddressCanonical,
          recipient: recipientCanonical,
          subject: parsed.subject,
          messageId: parsed.messageId,
          reason: rejection.reason,
          ruleId: rejection.rule.id,
          ruleName: rejection.rule.name,
        }),
      );
    } catch (error) {
      console.warn("Failed to record an inbound rejection:", error);
    }
    console.log(
      `Rejected email from ${fromAddressCanonical} to ${recipientCanonical} by rule ${rejection.rule.id}`,
    );
    return { status: "rejected", reason: rejection.reason };
  }

  // Stored exactly as the importer stores history, but as live mail: unread,
  // counted as unread for its person, with the filter's score.
  const {
    emailId,
    personId: actualPersonId,
    conversationId,
    threadKey,
    bodyHtml,
  } = await storeReceivedMessage(db, env, {
    parsed,
    inbox: recipientCanonical,
    fromAddress: fromAddressCanonical,
    receivedAt: now,
    now,
    source: "inbound",
    ourDomains: domainsOf(identityRows.map((r) => r.email)),
    spamProbability,
    threadingMode: inboxIdentity?.threadingMode ?? "relationship",
    ...providerIds,
  });
  // The webhook and the forward describe the first 50 attachments, as they
  // always have.
  const cappedAttachments = parsed.attachments.slice(0, MAX_ATTACHMENTS);

  let autoFiledSpam = false;
  if (
    inboxIdentity?.spamThreshold !== null &&
    inboxIdentity?.spamThreshold !== undefined &&
    parsed.spamScore !== null &&
    parsed.spamScore >= inboxIdentity.spamThreshold
  ) {
    try {
      await setSystemSpamState(db, recipientCanonical, emailId);
      autoFiledSpam = true;
    } catch (error) {
      console.warn("Failed to auto-file inbound message as spam:", error);
    }
  }

  let ruleSnoozed = false;
  if (!autoFiledSpam) {
    try {
      const ruleResult = await runMatchedRules(
        db,
        matchedRules,
        {
          ...ruleMessage,
          emailId,
          inbox: recipientCanonical,
          bodyHtml,
          now,
        },
        { env, ctx },
      );
      autoFiledSpam ||= ruleResult.markedSpam;
      ruleSnoozed = ruleResult.snoozed;
    } catch (error) {
      console.warn("Failed to run inbound rules:", error);
    }
  }

  if (
    shouldEnqueueSuggestedReply({
      agentAutodraft: inboxIdentity?.agentAutodraft,
      autoFiledSpam,
      modelConfigured: selectModel(env).ok,
      headers: parsed.headers,
      senderAddress: fromAddressCanonical,
    })
  ) {
    ctx.waitUntil(
      env.EMAIL_QUEUE.send({ type: "suggest_reply", emailId }).catch(
        (error) => {
          console.warn("Failed to enqueue suggested reply:", error);
        },
      ),
    );
  }

  if (!autoFiledSpam) {
    // A new non-spam inbound message wakes its conversation. Junk is silent:
    // auto-filed spam must not resurface a snoozed customer conversation.
    if (!ruleSnoozed) {
      try {
        await wakeConversation(
          db,
          recipientCanonical,
          threadKey ?? conversationId ?? `p:${actualPersonId}`,
        );
      } catch (error) {
        console.warn("Failed to wake snoozed conversation:", error);
      }
    }

    // Notify connected WebSocket clients about non-spam mail (per-user DOs).
    // Fan out to users with explicit permission for this inbox, plus admins
    // (capped) — all best-effort via ctx.waitUntil so push failures never
    // block the inbound-email path.
    ctx.waitUntil(
      (async () => {
        try {
          const [permRows, adminRows] = await Promise.all([
            db
              .select({ userId: inboxPermissions.userId })
              .from(inboxPermissions)
              .where(eq(inboxPermissions.email, recipientCanonical)),
            db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.role, "admin"))
              .limit(MAX_ADMIN_FANOUT + 1),
          ]);
          const { userIds, adminTruncated } = computeFanoutTargets({
            permissionUserIds: permRows.map((r) => r.userId),
            adminUserIds: adminRows.map((r) => r.id),
          });
          if (adminTruncated) {
            console.warn(
              `Admin count exceeds notification fanout cap (${MAX_ADMIN_FANOUT}); truncating.`,
            );
          }
          const deliverPayload = JSON.stringify({
            inbox: recipientCanonical,
            threadId: actualPersonId,
            personId: actualPersonId,
            senderName: parsed.from.name || fromAddressCanonical,
            subject: parsed.subject ?? "",
            bodyPreview: messagePreview(parsed.bodyText, parsed.bodyHtml),
          });
          const results = await Promise.allSettled(
            userIds.map((userId) => {
              const hub = env.NOTIFICATIONS_HUB.get(
                env.NOTIFICATIONS_HUB.idFromName(userId),
              );
              return hub.fetch(
                new Request("http://do/deliver", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: deliverPayload,
                }),
              );
            }),
          );
          const failures = results.filter(
            (r) => r.status === "rejected",
          ).length;
          if (failures > 0) {
            console.warn(
              `Real-time fanout: ${failures}/${results.length} DO notifies failed`,
            );
          }
        } catch (err) {
          // Non-fatal: real-time push is best-effort.
          console.warn("Real-time fanout error:", err);
        }
      })(),
    );
  }

  // Best-effort outbound webhook for external automation (n8n / Make / etc.).
  // No-op unless an admin has configured a destination URL. Mirrors the push
  // fan-out: fire-and-forget via ctx.waitUntil so a slow/failing receiver
  // never blocks ingestion. One event per received message (after dedupe).
  deliverWebhook(
    db,
    ctx,
    buildWebhookPayload({
      emailId,
      receivedAt: now,
      inbox: recipientCanonical,
      fromAddress: parsed.from.address,
      fromName: parsed.from.name || null,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      conversationId,
      attachments: cappedAttachments.map((a) => ({
        filename: sanitizeFilename(a.filename),
        contentType: a.contentType,
        size: a.content.byteLength,
      })),
      auth: parsed.auth,
      baseUrl: env.BASE_URL,
    }),
  );

  // Per-inbox forwarding ("redirect rule"). Re-sends this message to the
  // inbox's configured destination through the outbound provider, because
  // Cloudflare Email Routing's own forwarding rules relay from IPs that Outlook
  // blocklists (550 5.7.1 S3150). See lib/inbound-forward.ts for the full
  // rationale. Best-effort and non-blocking, like the webhook above — and it
  // sits after the blocklist and dedupe gates, so blocked senders and duplicate
  // deliveries are never forwarded.
  forwardInbound(env, ctx, {
    inbox: recipientCanonical,
    forwardTo: inboxIdentity?.forwardTo ?? null,
    inboxDisplayName: inboxIdentity?.displayName ?? null,
    from: parsed.from,
    subject: parsed.subject,
    fullBodyHtml: parsed.fullBodyHtml,
    fullBodyText: parsed.fullBodyText,
    messageId: parsed.messageId,
    receivedAt: now,
    cc: parsed.cc,
    auth: parsed.auth,
    attachments: cappedAttachments,
    headers: parsed.headers,
    knownInboxes: identityRows.map((r) => r.email),
  });

  // Cancel any active sequences for this person.
  //
  // Guarded, like the identical call in `mirrorSentMessage`, and for the same
  // reason: the `emails` row above is already committed, so a throw here
  // would stop the Gmail sync's run AND leave the retry hitting the per-inbox
  // dedupe — the message would be skipped forever and the cancellation lost
  // permanently, so the customer who just wrote in keeps getting automated
  // follow-ups. A sequence that keeps running is worth an operator's
  // attention; it is not worth discarding mail that is already on the
  // timeline.
  try {
    await cancelSequencesForPerson(db, actualPersonId);
  } catch (err) {
    console.error(
      `Stored the message from ${fromAddressCanonical} to ${recipientCanonical}, but cancelling their sequences failed; they may keep receiving automated follow-ups:`,
      err instanceof Error ? err.message : "unknown error",
    );
  }

  console.log(
    `Processed email from ${fromAddressCanonical} to ${recipientCanonical} (${parsed.attachments.length} attachments)`,
  );
  return { status: "stored", emailId };
}
