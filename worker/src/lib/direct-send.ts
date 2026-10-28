import { and, eq, isNotNull, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sentEmails } from "../db/sent-emails.schema";
import type { EmailSender, SendEmailResult } from "./email-sender/types";
import { deleteMessageState } from "./messages/state";
import { discardSentAttachments } from "./sent-attachments";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/**
 * Mail through a connected Gmail or Outlook mailbox goes out at once or not at
 * all: it never gets an outbox row. The outbox stores no transport, and a
 * disconnect or remap resets the inbox, so a held row could later leave
 * through Cloudflare or another account (docs/gmail.md, docs/outlook.md).
 */
export function sendsDirect(sender: EmailSender): boolean {
  return sender.provider === "gmail" || sender.provider === "outlook";
}

function mailboxName(sender: EmailSender): string {
  return sender.provider === "outlook" ? "Outlook" : "Gmail";
}

/** The refusal of a send a mapped inbox would have to hold. */
export const MAILBOX_SEND_NOT_HELD_CODE = "MAILBOX_SEND_NOT_HELD";

export function notHeldMessage(sender: EmailSender, why: string): string {
  return (
    `${why}, and mail from an inbox connected to ${mailboxName(sender)} ` +
    "cannot be held: it goes out at once or not at all. Nothing was sent or " +
    "stored."
  );
}

export interface DirectSendFailure {
  message: string;
  /**
   * True when the provider may have sent it (timeout, network error, 5xx, or
   * accepted without an id): a retry with the same idempotency key must
   * replay the failure, never send again.
   */
  uncertain: boolean;
}

/** What a failed Gmail or Outlook send tells the user, and whether it may have gone out. */
export function directSendFailure(
  sender: EmailSender,
  result: SendEmailResult,
): DirectSendFailure | null {
  const error = result.error;
  if (!error) return null;
  const name = mailboxName(sender);
  if (error.delivered) return { message: error.message, uncertain: true };
  if (error.uncertain) {
    return {
      message:
        `${name} may have sent this message: ${error.message}. It was not ` +
        `queued for retry. Check the mailbox's Sent folder before sending it ` +
        "again, from a new draft.",
      uncertain: true,
    };
  }
  if (error.reconnect) {
    return {
      message: `${error.message} This message was not sent and was not queued for retry.`,
      uncertain: false,
    };
  }
  return {
    message:
      `${name} did not accept this message, and it was not queued for ` +
      `retry: ${error.message}. Send it again to retry.`,
    uncertain: false,
  };
}

/** The provider's ids for a message it just accepted, for its `sent_emails` row. */
export function providerIdsOf(
  sender: EmailSender,
  result: SendEmailResult | undefined,
): { gmailMessageId: string | null; gmailThreadId: string | null } {
  if (sender.provider !== "gmail") {
    return { gmailMessageId: null, gmailThreadId: null };
  }
  return {
    gmailMessageId: result?.id ?? null,
    gmailThreadId: result?.threadId ?? null,
  };
}

/**
 * The mirrored Sent copy of the message this send is writing, when the sync
 * stored it first: Gmail files the Sent copy the moment it answers, so a sync
 * between that answer and the send's own insert mirrors it. Null when the
 * send went through neither mailbox.
 */
export function sentEchoWhere(
  sender: EmailSender,
  row: {
    fromAddress: string;
    messageId: string | null;
    gmailMessageId: string | null;
  },
): SQL | null {
  if (sender.provider === "gmail" && row.gmailMessageId) {
    return and(
      eq(sentEmails.gmailMessageId, row.gmailMessageId),
      eq(sentEmails.fromAddress, row.fromAddress),
    )!;
  }
  // Outlook returns no id: the mirror is known by the Message-ID saasmail wrote.
  if (sender.provider === "outlook" && row.messageId) {
    return and(
      eq(sentEmails.messageId, row.messageId),
      eq(sentEmails.fromAddress, row.fromAddress),
      isNotNull(sentEmails.outlookMessageId),
    )!;
  }
  return null;
}

/**
 * Before the send's row replaces a mirrored echo: the echo's message state
 * goes first (every hard delete does), and its ids are returned so that its
 * attachment files can go once the batch has removed it.
 */
export async function clearEchoState(
  db: Db,
  where: SQL | null,
): Promise<string[]> {
  if (!where) return [];
  const echoes = await db
    .select({ id: sentEmails.id })
    .from(sentEmails)
    .where(where);
  const ids = echoes.map((row: { id: string }) => row.id);
  if (ids.length > 0) {
    await deleteMessageState(
      db,
      ids.map((id: string) => ({ kind: "sent" as const, id })),
    );
  }
  return ids;
}

/** The echoes' attachment rows and files, after the batch deleted the rows. */
export async function discardEchoFiles(
  db: Db,
  env: CloudflareBindings,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    try {
      await discardSentAttachments(db, env, id);
    } catch (error) {
      console.warn(`[send] files of the replaced Sent copy ${id} kept:`, error);
    }
  }
}

/**
 * Writes the send's `sent_emails` row, replacing a mirrored echo in the same
 * batch so the sync cannot slip a second copy between the two statements.
 */
export async function insertSentRowReplacingEcho(
  db: Db,
  env: CloudflareBindings,
  sender: EmailSender,
  row: typeof sentEmails.$inferInsert,
): Promise<void> {
  const where = sentEchoWhere(sender, {
    fromAddress: row.fromAddress,
    messageId: row.messageId ?? null,
    gmailMessageId: row.gmailMessageId ?? null,
  });
  if (!where) {
    await db.insert(sentEmails).values(row);
    return;
  }
  const echoIds = await clearEchoState(db, where);
  await db.batch([
    db.delete(sentEmails).where(where),
    db.insert(sentEmails).values(row),
  ]);
  await discardEchoFiles(db, env, echoIds);
}
