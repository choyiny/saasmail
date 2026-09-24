import { inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { emails } from "../../db/emails.schema";
import { sentEmails } from "../../db/sent-emails.schema";

/**
 * Forget the Gmail threads filed under these inboxes.
 *
 * Gmail thread ids are per-MAILBOX, and `emails.gmail_thread_id` records
 * whichever account was mapped when the message was synced. Nothing records
 * WHICH account issued a given id, so the moment an inbox is remapped — the
 * documented migration when the person who owned a collector mailbox leaves —
 * every stored id in it becomes a claim no one can check.
 *
 * Left alone they are worse than useless. `threadIdForSender` would hand one
 * to the new account's `users/me/messages/send`; Gmail answers 4xx, which
 * classifies as terminal, and a terminal Gmail failure is deliberately never
 * queued — so every thread predating the remap became permanently unreplyable
 * with the UI telling the user to send it again, and the only exit was a
 * manual D1 UPDATE.
 *
 * Clearing them costs the Gmail-side threading on old conversations: replies
 * start a new Gmail thread, and the saasmail timeline (grouped by person and
 * `conversation_id`, not by this column) does not move. That is the same
 * trade `threadIdForSender` already makes when a thread belongs to another
 * inbox — losing the threading beats a reply that can never be sent.
 *
 * Call this wherever an inbox's `gmail_account_id` stops being the one its
 * stored ids came from: a remap, an unmap, or a disconnect.
 */
export async function clearGmailThreadIds(
  db: DrizzleD1Database<typeof schema>,
  inboxes: string[],
): Promise<void> {
  if (inboxes.length === 0) return;
  await db.batch([
    db
      .update(emails)
      .set({ gmailThreadId: null })
      .where(inArray(emails.recipient, inboxes)),
    db
      .update(sentEmails)
      .set({ gmailThreadId: null })
      .where(inArray(sentEmails.fromAddress, inboxes)),
  ]);
}
