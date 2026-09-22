import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schema } from "./db/schema";
import { people } from "./db/people.schema";
import { emails } from "./db/emails.schema";
import { attachments } from "./db/attachments.schema";
import { inboxPermissions } from "./db/inbox-permissions.schema";
import { senderIdentities } from "./db/sender-identities.schema";
import { users } from "./db/auth.schema";
import { parseEmail } from "./lib/email-parser";
import type { ParsedEmail } from "./lib/email-parser";
import { isBlocked } from "./lib/blocklist";
import { computeConversationId, externalsOnly } from "./lib/conversation-id";
import { cancelSequencesForPerson } from "./lib/cancel-sequence";
import { internalDomainsFrom } from "./lib/internal-domains";
import {
  MAX_ADMIN_FANOUT,
  computeFanoutTargets,
} from "./lib/notification-fanout";
import { sanitizeFilename } from "./lib/sanitize-filename";
import { buildWebhookPayload, deliverWebhook } from "./lib/webhook-delivery";
import { forwardInbound } from "./lib/inbound-forward";

const MAX_ATTACHMENTS = 50;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

/** Cloudflare Email Worker entry point. */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: CloudflareBindings,
  ctx: ExecutionContext,
): Promise<void> {
  const db = drizzle(env.DB, { schema, logger: true });
  const parsed = await parseEmail(message);
  await ingestParsedEmail(db, parsed, env, ctx);
}

/**
 * What an ingest actually did.
 *
 * This used to be `void` for all three outcomes, so a caller counting
 * deliveries could not tell a stored message from one the blocklist or the
 * dedupe threw away. The Gmail sync counted every one of them as `ingested`
 * and advanced its history cursor accordingly — a drop reported as a success,
 * after which the mail was unreachable by any code path. Naming the outcome is
 * what lets a caller decide, and `emailId` is what lets the sync stamp Gmail's
 * ids onto the row this call created instead of guessing at it by Message-ID.
 */
export type IngestOutcome =
  /** A new `emails` row was written; `emailId` is its primary key. */
  | { status: "stored"; emailId: string }
  /** The sender is on the blocklist. Nothing was written. */
  | { status: "blocked" }
  /**
   * This inbox already holds this Message-ID — a retry, a replayed Gmail
   * history page, or two overlapping cron ticks. Nothing was written;
   * `emailId` is the row that was already there.
   */
  | { status: "duplicate"; emailId: string };

/**
 * Store an already-parsed inbound message and run every side effect that
 * follows: blocklist, dedupe, person matching, conversation grouping,
 * attachments, notification fan-out, webhooks, forwarding and sequence
 * cancellation.
 *
 * Source-agnostic on purpose. The Cloudflare Email Worker reaches it via
 * `handleEmail`; a later Gmail sync calls it directly with a `ParsedEmail`
 * built from `messages.get(format=raw)`, setting `parsed.to` to the inbox
 * the message should land in.
 */
export async function ingestParsedEmail(
  db: DrizzleD1Database<typeof schema>,
  parsed: ParsedEmail,
  env: CloudflareBindings,
  ctx: ExecutionContext,
): Promise<IngestOutcome> {
  const now = Math.floor(Date.now() / 1000);

  // Canonicalize inbox addresses to lowercase before storage so casing
  // variants of the same recipient don't fork into separate group-row
  // buckets (the grouped query keys by `(conversation_id, inbox)`, and
  // conversation_id is computed from lowercased inputs already — we
  // need the stored column to match).
  const recipientCanonical = parsed.to.trim().toLowerCase();
  const fromAddressCanonical = parsed.from.address.trim().toLowerCase();

  // Drop mail from blocked senders/domains before any storage or side effects.
  if (await isBlocked(db, fromAddressCanonical)) {
    console.log(`Dropped blocked email from ${fromAddressCanonical}`);
    return { status: "blocked" };
  }

  // Deduplicate by Message-ID, PER INBOX.
  //
  // Scoped to `recipient` because one message addressed to two of our inboxes
  // is two deliveries, not a duplicate: the two copies carry the same
  // Message-ID, and matching on that alone dropped the second inbox's copy on
  // the floor. The duplicate this check actually exists to absorb — the same
  // message offered to the SAME inbox twice, by a retry or a replayed Gmail
  // history page — is still caught, and the `emails_message_recipient_unique`
  // index backs it so a race between two callers cannot slip a copy past.
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
      console.log(
        `Duplicate email with Message-ID ${parsed.messageId} for ${recipientCanonical}`,
      );
      return { status: "duplicate", emailId: existing[0]!.id };
    }
  }

  const senderAuthenticated =
    parsed.auth.spf === "pass" ||
    parsed.auth.dkim === "pass" ||
    parsed.auth.dmarc === "pass";

  // Upsert person — only update name if sender passes authentication
  const personId = nanoid();
  await db
    .insert(people)
    .values({
      id: personId,
      email: fromAddressCanonical,
      name: parsed.from.name || null,
      lastEmailAt: now,
      unreadCount: 1,
      totalCount: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: people.email,
      set: {
        ...(senderAuthenticated
          ? { name: sql`COALESCE(${parsed.from.name || null}, ${people.name})` }
          : {}),
        lastEmailAt: now,
        unreadCount: sql`${people.unreadCount} + 1`,
        totalCount: sql`${people.totalCount} + 1`,
        updatedAt: now,
      },
    });

  // Get the actual person ID (could be existing). Lookup by the
  // canonical (lowercased) email so legacy mixed-case rows still
  // resolve to the same person.
  const personRow = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, fromAddressCanonical))
    .limit(1);
  const actualPersonId = personRow[0]!.id;

  // PLAN the attachments — ids, keys and the CID map — without storing
  // anything yet. The ids are minted here because the CID rewrite below needs
  // them, and nothing else about this step requires I/O.
  //
  // The storing itself happens AFTER the `emails` insert. It used to happen
  // before, and a failure in between — a D1 blip, `SQLITE_TOOBIG` on a very
  // large body, the scheduled handler hitting the CPU limit mid-record — left
  // `attachments` rows and R2 objects pointing at an `emails` row that was
  // never written. Unreachable and uncollectable: every delete path
  // (`lib/delete-email.ts`, `people-router.ts`) finds attachments BY an email
  // or a person, so nothing ever sees them. Worse, the retry minted a fresh
  // `emailId`, re-uploaded the bytes and inserted another orphan — 96 cron
  // ticks a day, forever, for one deterministically failing message.
  const cidMap: Record<string, string> = {};
  const emailId = nanoid();

  // Enforce attachment limits
  const cappedAttachments = parsed.attachments.slice(0, MAX_ATTACHMENTS);
  let totalAttachmentBytes = 0;
  const plannedAttachments: Array<{
    id: string;
    r2Key: string;
    filename: string;
    contentId: string | null;
    content: ArrayBuffer | Uint8Array;
    contentType: string;
    size: number;
  }> = [];

  for (const att of cappedAttachments) {
    totalAttachmentBytes += att.content.byteLength;
    if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      console.log(
        `Attachment size limit exceeded for email from ${parsed.from.address}, skipping remaining attachments`,
      );
      break;
    }

    const safeFilename = sanitizeFilename(att.filename);
    const attachmentId = nanoid();
    const isInline = att.disposition === "inline" && !!att.contentId;

    plannedAttachments.push({
      id: attachmentId,
      r2Key: `attachments/${emailId}/${attachmentId}/${safeFilename}`,
      filename: safeFilename,
      contentId: isInline ? att.contentId : null,
      content: att.content,
      contentType: att.contentType,
      size: att.content.byteLength,
    });

    if (isInline && att.contentId) {
      const cleanCid = att.contentId.replace(/^<|>$/g, "");
      cidMap[cleanCid] = attachmentId;
    }
  }

  // Rewrite CID references in HTML body
  let bodyHtml = parsed.bodyHtml;
  if (bodyHtml && Object.keys(cidMap).length > 0) {
    for (const [cid, attachmentId] of Object.entries(cidMap)) {
      bodyHtml = bodyHtml.replace(
        new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"),
        `/api/attachments/${attachmentId}/inline`,
      );
    }
  }

  // Compute the conversation_id, if this is a multi-participant thread.
  // External participants = the sender + everyone on the Cc line, minus
  // any addresses that match one of our sender_identities (those are
  // "internal" team members and don't change the group identity).
  //
  // One scan of sender_identities serves three consumers: the "our domains"
  // set below, the forward destination for this inbox, and the known-inbox
  // loop guard in `forwardInbound`.
  const identityRows = await db
    .select({
      email: senderIdentities.email,
      displayName: senderIdentities.displayName,
      forwardTo: senderIdentities.forwardTo,
    })
    .from(senderIdentities);

  const ourDomains = internalDomainsFrom(identityRows);
  const allParticipants = [
    fromAddressCanonical,
    ...parsed.cc.map((c) => c.email),
  ];
  const externals = externalsOnly(allParticipants, ourDomains);
  const conversationId = await computeConversationId(
    recipientCanonical,
    externals,
  );

  // Insert email (with rewritten HTML and auth results). Store the
  // canonical (lowercased) recipient so it matches the conversation
  // group key.
  await db.insert(emails).values({
    id: emailId,
    personId: actualPersonId,
    recipient: recipientCanonical,
    subject: parsed.subject,
    bodyHtml,
    bodyText: parsed.bodyText,
    rawHeaders: JSON.stringify(parsed.headers),
    messageId: parsed.messageId,
    spf: parsed.auth.spf,
    dkim: parsed.auth.dkim,
    dmarc: parsed.auth.dmarc,
    spamScore: parsed.spamScore,
    isRead: 0,
    cc: parsed.cc.length > 0 ? JSON.stringify(parsed.cc) : null,
    conversationId,
    receivedAt: now,
    createdAt: now,
  });

  // Now store the attachments, against a row that exists. A failure from here
  // on leaves this message on the timeline without some of its attachments —
  // and the retry is caught by the per-inbox dedupe above, so it is a bounded
  // loss reported as a skip, not an unbounded accumulation of orphans and a
  // person's counters climbing by one per tick.
  for (const att of plannedAttachments) {
    await env.R2.put(att.r2Key, att.content, {
      httpMetadata: { contentType: att.contentType },
    });
    await db.insert(attachments).values({
      id: att.id,
      emailId,
      kind: "inbound",
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      r2Key: att.r2Key,
      contentId: att.contentId,
      createdAt: now,
    });
  }

  // Notify connected WebSocket clients about the new email (per-user DOs).
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
          bodyPreview: (parsed.bodyText ?? "").slice(0, 140),
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
        const failures = results.filter((r) => r.status === "rejected").length;
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
  const inboxIdentity = identityRows.find(
    (r) => r.email.trim().toLowerCase() === recipientCanonical,
  );
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
