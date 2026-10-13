import { eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../../db/emails.schema";
import { sentEmails } from "../../db/sent-emails.schema";
import { senderIdentities } from "../../db/sender-identities.schema";
import { attachments } from "../../db/attachments.schema";
import { people } from "../../db/people.schema";
import { parseCc } from "../messages/adapters";
import { queryMessages } from "../messages/query";
import type { AllowedInboxes } from "../inbox-permissions";
import { isInboxAllowed } from "../inbox-permissions";

export { parseCc };

export type CcEntry = { email: string; name?: string | null };

export type AttachmentRow = typeof attachments.$inferSelect;

export type InboxMeta = {
  email: string;
  displayName: string | null;
  displayMode: "thread" | "chat";
};

export type PersonEmailRow = {
  id: string;
  type: "received" | "sent";
  personId: string | null;
  recipient: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isRead: number | null;
  cc: CcEntry[];
  timestamp: number;
  status: string | null;
  campaignId?: string | null;
  attachmentCount: number;
  attachments: AttachmentRow[];
};

export type ListPersonEmailsOptions = {
  q?: string;
  recipient?: string;
  page: number;
  limit: number;
};

export type ListPersonEmailsResult = {
  emails: PersonEmailRow[];
  inboxes: InboxMeta[];
};

export type ReceivedEmailDetail = Omit<typeof emails.$inferSelect, "cc"> & {
  type: "received";
  timestamp: number;
  fromAddress: string | null;
  toAddress: null;
  replyTo: string | null;
  cc: CcEntry[];
  attachments: AttachmentRow[];
};

export type SentEmailDetail = {
  id: string;
  type: "sent";
  personId: string | null;
  recipient: null;
  fromAddress: string;
  toAddress: string;
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  isRead: null;
  replyTo: null;
  cc: CcEntry[];
  timestamp: number;
  status: string;
  attachments: AttachmentRow[];
};

export type EmailDetail = ReceivedEmailDetail | SentEmailDetail;

/**
 * Pull the Reply-To address out of an email's stored raw headers.
 * `raw_headers` is a JSON object of all inbound headers (see email-handler),
 * so no schema change is needed to surface this. Returns the bare address
 * (lower-cased), unwrapping a "Name <addr>" form. Null when absent/malformed.
 */
function extractReplyTo(rawHeaders: string | null): string | null {
  if (!rawHeaders) return null;
  try {
    const headers = JSON.parse(rawHeaders) as Record<string, unknown>;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "reply-to" && typeof value === "string") {
        const angle = value.match(/<([^>]+)>/);
        const addr = (angle ? angle[1] : value).trim().toLowerCase();
        return addr || null;
      }
    }
  } catch {
    // Malformed raw_headers — treat as no Reply-To rather than failing the read.
  }
  return null;
}

/** Reply-To is only meaningful when it differs from the attributed sender. */
export function surfaceReplyTo(
  rawHeaders: string | null,
  personEmail: string | null,
): string | null {
  const replyTo = extractReplyTo(rawHeaders);
  if (!replyTo) return null;
  const person = personEmail?.trim().toLowerCase();
  if (person && replyTo === person) return null;
  return replyTo;
}

/** Compatibility wrapper for the existing person-timeline API. */
export async function listPersonEmails(
  db: DrizzleD1Database<any>,
  personId: string,
  opts: ListPersonEmailsOptions,
  allowed: AllowedInboxes,
): Promise<ListPersonEmailsResult> {
  const { q, recipient, page, limit } = opts;
  const requested = Math.max(Math.floor(limit), 0);
  if (requested === 0) return { emails: [], inboxes: [] };

  const pageResult = await queryMessages(db, allowed, {
    personId,
    inboxes: recipient !== undefined ? [recipient] : undefined,
    search: q,
    searchMode: "subject",
    offset: Math.max((page - 1) * requested, 0),
    limit: requested,
    withAttachmentCounts: true,
    withAttachments: true,
    includeTrashed: false,
    includeSpam: false,
  });

  const result: PersonEmailRow[] = pageResult.messages.map((message) => ({
    id: message.ref.id,
    type: message.ref.kind,
    personId: message.personId,
    recipient: message.ref.kind === "received" ? message.inbox : null,
    fromAddress:
      message.ref.kind === "received"
        ? (message.from?.email ?? null)
        : (message.from?.email ?? message.inbox),
    toAddress: message.ref.kind === "sent" ? message.to.email : null,
    subject: message.subject,
    bodyHtml: message.bodyHtml,
    bodyText: message.bodyText,
    isRead: message.isRead === null ? null : message.isRead ? 1 : 0,
    cc: message.cc,
    timestamp: message.occurredAt,
    status: message.delivery?.status ?? null,
    campaignId: message.source.campaignId,
    attachmentCount: message.attachmentCount ?? 0,
    attachments: message.attachments ?? [],
  }));

  const inboxAddrs = [
    ...new Set(
      result
        .map((email) =>
          email.type === "received" ? email.recipient : email.fromAddress,
        )
        .filter((email): email is string => !!email),
    ),
  ];

  const identities =
    inboxAddrs.length > 0
      ? await db
          .select({
            email: senderIdentities.email,
            displayName: senderIdentities.displayName,
            displayMode: senderIdentities.displayMode,
          })
          .from(senderIdentities)
          .where(inArray(senderIdentities.email, inboxAddrs))
      : [];
  const identityMap = new Map(identities.map((row) => [row.email, row]));

  const inboxes = inboxAddrs.map((email) => {
    const identity = identityMap.get(email);
    return {
      email,
      displayName: identity?.displayName ?? null,
      displayMode: (identity?.displayMode ?? "chat") as "thread" | "chat",
    };
  });

  return { emails: result, inboxes };
}

/**
 * Look up a single message by id across both the received and sent tables.
 * Null covers "no such message" and "caller doesn't own the inbox" alike so
 * an id probe can't confirm existence.
 */
export async function getEmailById(
  db: DrizzleD1Database<any>,
  id: string,
  allowed: AllowedInboxes,
): Promise<EmailDetail | null> {
  // Look up the id in `emails` (received) first.
  const row = await db.select().from(emails).where(eq(emails.id, id)).limit(1);

  if (row.length > 0) {
    if (!isInboxAllowed(allowed, row[0].recipient)) {
      return null;
    }
    const atts = await db
      .select()
      .from(attachments)
      .where(eq(attachments.emailId, id));
    const senderRow = await db
      .select({ email: people.email })
      .from(people)
      .where(eq(people.id, row[0].personId))
      .limit(1);
    return {
      ...row[0],
      type: "received",
      timestamp: row[0].receivedAt,
      fromAddress: senderRow[0]?.email ?? null,
      toAddress: null,
      replyTo: surfaceReplyTo(row[0].rawHeaders, senderRow[0]?.email ?? null),
      cc: parseCc(row[0].cc),
      attachments: atts,
    };
  }

  // Fall back to `sent_emails`. The reply route already accepts both
  // tables as reply targets, but historically this lookup didn't —
  // which meant ReplyComposer's "what you're replying to" panel never
  // rendered when the user clicked Reply on one of our own outgoing
  // messages, and the silent .catch in the client masked the 404.
  const sentRow = await db
    .select()
    .from(sentEmails)
    .where(eq(sentEmails.id, id))
    .limit(1);

  if (sentRow.length === 0) {
    return null;
  }

  // Authorization mirrors the reply route's defense-in-depth — only
  // surface a sent row to a caller who still owns the inbox that sent it.
  if (!isInboxAllowed(allowed, sentRow[0].fromAddress)) {
    return null;
  }

  const sent = sentRow[0];
  const sentAtts = await db
    .select()
    .from(attachments)
    .where(eq(attachments.emailId, id));
  return {
    id: sent.id,
    type: "sent",
    personId: sent.personId,
    recipient: null,
    fromAddress: sent.fromAddress,
    toAddress: sent.toAddress,
    subject: sent.subject,
    bodyHtml: sent.bodyHtml,
    bodyText: sent.bodyText,
    isRead: null,
    replyTo: null,
    cc: parseCc(sent.cc),
    timestamp: sent.sentAt,
    status: sent.status,
    attachments: sentAtts,
  };
}

/**
 * Mark a received email read/unread, keeping the person's cached unread
 * counter in step. Null when the message doesn't exist or the caller doesn't
 * own its inbox. `changed` is false when the flag already had the target
 * value (no write, no counter drift).
 */
export async function setEmailRead(
  db: DrizzleD1Database<any>,
  id: string,
  isRead: boolean,
  allowed: AllowedInboxes,
): Promise<{ changed: boolean } | null> {
  const email = await db
    .select({
      personId: emails.personId,
      isRead: emails.isRead,
      recipient: emails.recipient,
    })
    .from(emails)
    .where(eq(emails.id, id))
    .limit(1);

  if (email.length === 0) {
    return null;
  }

  if (!isInboxAllowed(allowed, email[0].recipient)) {
    return null;
  }

  const wasRead = email[0].isRead === 1;
  const nowRead = isRead;

  if (wasRead !== nowRead) {
    await db
      .update(emails)
      .set({ isRead: nowRead ? 1 : 0 })
      .where(eq(emails.id, id));

    // Update person unread count
    const delta = nowRead ? -1 : 1;
    await db
      .update(people)
      .set({
        unreadCount: sql`${people.unreadCount} + ${delta}`,
      })
      .where(eq(people.id, email[0].personId));
  }

  return { changed: wasRead !== nowRead };
}
