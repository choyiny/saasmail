import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../../db/emails.schema";
import { sentEmails } from "../../db/sent-emails.schema";
import { senderIdentities } from "../../db/sender-identities.schema";
import { attachments } from "../../db/attachments.schema";
import { people } from "../../db/people.schema";
import { escapeLike } from "../helpers";
import { inboxFilter, type AllowedInboxes } from "../inbox-permissions";

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

/** Parse a stored cc TEXT column (JSON) into a typed array, falling back to
 *  [] for NULL or any malformed/corrupt JSON so a bad row never breaks reads. */
export function parseCc(raw: string | null | undefined): CcEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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

/**
 * List every message exchanged with a person (received + sent, interleaved
 * newest-first), plus per-inbox display metadata for the addresses involved.
 * Scoped to the caller's allowed inboxes on both sides of the conversation.
 */
export async function listPersonEmails(
  db: DrizzleD1Database<any>,
  personId: string,
  opts: ListPersonEmailsOptions,
  allowed: AllowedInboxes,
): Promise<ListPersonEmailsResult> {
  const { q, recipient, page, limit } = opts;
  const offset = (page - 1) * limit;

  // Build conditions for received emails
  const receivedConditions: any[] = [eq(emails.personId, personId)];
  if (q) {
    receivedConditions.push(like(emails.subject, `%${escapeLike(q)}%`));
  }
  if (recipient) {
    receivedConditions.push(eq(emails.recipient, recipient));
  }
  const recvScope = inboxFilter(allowed, emails.recipient);
  if (recvScope) receivedConditions.push(recvScope);

  const received = await db
    .select({
      id: emails.id,
      subject: emails.subject,
      bodyHtml: emails.bodyHtml,
      bodyText: emails.bodyText,
      isRead: emails.isRead,
      cc: emails.cc,
      timestamp: emails.receivedAt,
      recipient: emails.recipient,
    })
    .from(emails)
    .where(and(...receivedConditions))
    .orderBy(desc(emails.receivedAt));

  // Build conditions for sent emails
  const sentConditions: any[] = [eq(sentEmails.personId, personId)];
  if (q) {
    sentConditions.push(like(sentEmails.subject, `%${escapeLike(q)}%`));
  }
  if (recipient) {
    sentConditions.push(eq(sentEmails.fromAddress, recipient));
  }
  const sentScope = inboxFilter(allowed, sentEmails.fromAddress);
  if (sentScope) sentConditions.push(sentScope);

  const sent = await db
    .select({
      id: sentEmails.id,
      subject: sentEmails.subject,
      bodyHtml: sentEmails.bodyHtml,
      bodyText: sentEmails.bodyText,
      cc: sentEmails.cc,
      timestamp: sentEmails.sentAt,
      fromAddress: sentEmails.fromAddress,
      toAddress: sentEmails.toAddress,
      status: sentEmails.status,
    })
    .from(sentEmails)
    .where(and(...sentConditions))
    .orderBy(desc(sentEmails.sentAt));

  const personRow = await db
    .select({ email: people.email })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  const personEmail = personRow[0]?.email ?? null;

  // Merge and sort
  const merged = [
    ...received.map((e) => ({
      id: e.id,
      type: "received" as const,
      personId,
      recipient: e.recipient,
      fromAddress: personEmail,
      toAddress: null,
      subject: e.subject,
      bodyHtml: e.bodyHtml,
      bodyText: e.bodyText,
      isRead: e.isRead,
      cc: parseCc(e.cc),
      timestamp: e.timestamp,
      status: null,
    })),
    ...sent.map((e) => ({
      id: e.id,
      type: "sent" as const,
      personId,
      recipient: null,
      fromAddress: e.fromAddress,
      toAddress: e.toAddress,
      subject: e.subject,
      bodyHtml: e.bodyHtml,
      bodyText: e.bodyText,
      isRead: null,
      cc: parseCc(e.cc),
      timestamp: e.timestamp,
      status: e.status,
    })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  const paginated = merged.slice(offset, offset + limit);

  // Get attachment counts for received emails
  const receivedIds = paginated
    .filter((e) => e.type === "received")
    .map((e) => e.id);

  let attachmentCounts: Record<string, number> = {};
  if (receivedIds.length > 0) {
    const counts = await db
      .select({
        emailId: attachments.emailId,
        count: sql<number>`COUNT(*)`,
      })
      .from(attachments)
      .where(
        sql`${attachments.emailId} IN (${sql.join(
          receivedIds.map((id) => sql`${id}`),
          sql`,`,
        )})`,
      )
      .groupBy(attachments.emailId);

    for (const row of counts) {
      attachmentCounts[row.emailId] = row.count;
    }
  }

  // Fetch attachment details for received emails
  let attachmentDetails: Record<string, any[]> = {};
  if (receivedIds.length > 0) {
    const attRows = await db
      .select()
      .from(attachments)
      .where(
        sql`${attachments.emailId} IN (${sql.join(
          receivedIds.map((id) => sql`${id}`),
          sql`,`,
        )})`,
      );

    for (const att of attRows) {
      if (!attachmentDetails[att.emailId]) {
        attachmentDetails[att.emailId] = [];
      }
      attachmentDetails[att.emailId].push(att);
    }
  }

  // Same lookup for sent emails so the chat/thread surface includes outgoing
  // attachments. Mirrors conversations-router; sent rows only have
  // kind='sent' attachment rows, so no kind filter is needed.
  const sentIds = paginated.filter((e) => e.type === "sent").map((e) => e.id);
  let sentAttachmentDetails: Record<string, any[]> = {};
  if (sentIds.length > 0) {
    const attRows = await db
      .select()
      .from(attachments)
      .where(
        sql`${attachments.emailId} IN (${sql.join(
          sentIds.map((id) => sql`${id}`),
          sql`,`,
        )})`,
      );

    for (const att of attRows) {
      if (!sentAttachmentDetails[att.emailId]) {
        sentAttachmentDetails[att.emailId] = [];
      }
      sentAttachmentDetails[att.emailId].push(att);
    }
  }

  const result = paginated.map((e) => {
    const atts =
      e.type === "sent"
        ? (sentAttachmentDetails[e.id] ?? [])
        : (attachmentDetails[e.id] ?? []);
    const count =
      e.type === "sent" ? atts.length : (attachmentCounts[e.id] ?? 0);
    return {
      ...e,
      attachmentCount: count,
      attachments: atts,
    };
  });

  // Collect distinct inbox addresses referenced by the returned emails.
  const inboxAddrs = new Set<string>();
  for (const e of result) {
    if (e.type === "received" && e.recipient) inboxAddrs.add(e.recipient);
    if (e.type === "sent" && e.fromAddress) inboxAddrs.add(e.fromAddress);
  }
  const addrList = [...inboxAddrs];

  const identities =
    addrList.length > 0
      ? await db
          .select({
            email: senderIdentities.email,
            displayName: senderIdentities.displayName,
            displayMode: senderIdentities.displayMode,
          })
          .from(senderIdentities)
          .where(inArray(senderIdentities.email, addrList))
      : [];
  const identityMap = new Map(identities.map((r) => [r.email, r]));

  const inboxesMeta = addrList.map((email) => {
    const id = identityMap.get(email);
    return {
      email,
      displayName: id?.displayName ?? null,
      displayMode: (id?.displayMode ?? "chat") as "thread" | "chat",
    };
  });

  return { emails: result, inboxes: inboxesMeta };
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
    if (!allowed.isAdmin && !allowed.inboxes.includes(row[0].recipient)) {
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
  if (!allowed.isAdmin && !allowed.inboxes.includes(sentRow[0].fromAddress)) {
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

  if (!allowed.isAdmin && !allowed.inboxes.includes(email[0].recipient)) {
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
