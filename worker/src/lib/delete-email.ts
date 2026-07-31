import { eq, sql } from "drizzle-orm";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { attachments } from "../db/attachments.schema";
import { people } from "../db/people.schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { isInboxAllowed, type AllowedInboxes } from "./inbox-permissions";

/** Grants deletion of any email. For system callers (e.g. blocklist purge). */
export const SYSTEM_INBOX_ACCESS: AllowedInboxes = { isAdmin: true };

/**
 * Hard delete an email (received or sent) and all associated R2 attachments.
 * Updates person counts when deleting a received email.
 * Returns null if the email was not found.
 *
 * `allowed` scopes the delete to inboxes the caller may act on: a received
 * email is keyed by `recipient`, a sent one by `fromAddress`. A denied delete
 * is reported as not-found so callers cannot probe for ids they can't see.
 * The check lives here rather than at the call site because doing it in the
 * router meant the sent-email branch below could be reached unguarded.
 */
export async function deleteEmailWithAttachments(
  db: DrizzleD1Database<any>,
  r2: R2Bucket,
  emailId: string,
  allowed: AllowedInboxes,
): Promise<{ success: boolean; attachmentsDeleted: number } | null> {
  // Try received email first
  const received = await db
    .select({
      id: emails.id,
      personId: emails.personId,
      isRead: emails.isRead,
      recipient: emails.recipient,
    })
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  if (received.length > 0) {
    const email = received[0];
    if (!isInboxAllowed(allowed, email.recipient)) return null;

    // Delete R2 attachments
    const atts = await db
      .select({ r2Key: attachments.r2Key })
      .from(attachments)
      .where(eq(attachments.emailId, emailId));

    for (const att of atts) {
      await r2.delete(att.r2Key);
    }

    // Delete attachment DB records
    await db.delete(attachments).where(eq(attachments.emailId, emailId));

    // Delete the email
    await db.delete(emails).where(eq(emails.id, emailId));

    // Update person counts
    const unreadDelta = email.isRead === 0 ? -1 : 0;
    await db
      .update(people)
      .set({
        totalCount: sql`MAX(${people.totalCount} - 1, 0)`,
        ...(unreadDelta
          ? { unreadCount: sql`MAX(${people.unreadCount} - 1, 0)` }
          : {}),
      })
      .where(eq(people.id, email.personId));

    return { success: true, attachmentsDeleted: atts.length };
  }

  // Try sent email
  const sent = await db
    .select({ id: sentEmails.id, fromAddress: sentEmails.fromAddress })
    .from(sentEmails)
    .where(eq(sentEmails.id, emailId))
    .limit(1);

  if (sent.length > 0) {
    if (!isInboxAllowed(allowed, sent[0].fromAddress)) return null;

    // Outbound messages DO carry attachments — the send path writes rows with
    // kind "sent" keyed on the sent_emails id. Skipping them here orphaned the
    // rows and leaked their R2 objects forever, while reporting success on a
    // "permanent" delete.
    const atts = await db
      .select({ r2Key: attachments.r2Key })
      .from(attachments)
      .where(eq(attachments.emailId, emailId));

    for (const att of atts) {
      await r2.delete(att.r2Key);
    }
    await db.delete(attachments).where(eq(attachments.emailId, emailId));
    await db.delete(sentEmails).where(eq(sentEmails.id, emailId));

    return { success: true, attachmentsDeleted: atts.length };
  }

  return null;
}
