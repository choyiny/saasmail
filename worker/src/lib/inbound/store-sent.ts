import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { people } from "../../db/people.schema";
import { sentEmails } from "../../db/sent-emails.schema";
import { computeConversationId, externalsOnly } from "../conversation-id";
import type { ParsedAttachment, ParsedEmail } from "../email-parser";
import { findOrCreatePersonId } from "../sent-bookkeeping";
import {
  citedIdsOf,
  threadKeyForNewMessage,
  type ThreadingMode,
} from "../messages/thread-key";
import {
  discardStoredFiles,
  keptAttachments,
  storeAttachments,
  storedBody,
} from "./store-received";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export interface StoredSent {
  /**
   * False when a row for the same Gmail or Outlook message from this inbox
   * was already there: nothing was written and the files were discarded.
   */
  inserted: boolean;
  sentId: string;
  /** Null when `createPerson` is false and the recipient is unknown. */
  personId: string | null;
  conversationId: string | null;
  storedAttachments: ParsedAttachment[];
  droppedAttachments: number;
}

/**
 * Stores a message the inbox sent, as history: a `sent_emails` row
 * (`status: "sent"`) with its To, Cc and Bcc from the headers, the first
 * recipient's person (created without touching any counts), the conversation
 * id a live send to the same people gets, and its attachments. No outbox row,
 * no provider. Returns null for a message with no recipient at all.
 *
 * A message carrying a Gmail or Outlook id is written at most once per inbox
 * (the two unique indexes on `sent_emails`); a second store of it returns
 * `inserted: false`, so two overlapping syncs mirror it once.
 */
export async function storeSentMessage(
  db: Db,
  env: CloudflareBindings,
  input: {
    parsed: ParsedEmail;
    /** Canonical (lowercased) inbox address: the sender. */
    inbox: string;
    sentAt: number;
    now: number;
    /** Domains of our inboxes (see `domainsOf`). */
    ourDomains: string[];
    /** The import storing it; recorded on the row. */
    importJobId?: string | null;
    /** The inbox's threading mode, when the caller read it. */
    threadingMode?: ThreadingMode;
    /**
     * The counterparty, when the caller chose it from the headers (a synced
     * Sent folder does). Else the first To, Cc or Bcc address.
     */
    counterparty?: string;
    /**
     * False: look the person up and never create one (a synced Sent message
     * to an address we have never heard from stays off every timeline).
     */
    createPerson?: boolean;
    /** The synced mailbox's ids for the message, written with the row. */
    gmailMessageId?: string | null;
    gmailThreadId?: string | null;
    outlookMessageId?: string | null;
  },
): Promise<StoredSent | null> {
  const { parsed, inbox, sentAt, now } = input;
  const recipients = [...parsed.toList, ...parsed.cc, ...parsed.bcc];
  const primaryEmail = input.counterparty ?? recipients[0]?.email;
  if (!primaryEmail) return null;
  const additionalTo = parsed.toList.filter(
    (address) => address.email !== primaryEmail,
  );

  const personId =
    input.createPerson === false
      ? ((
          await db
            .select({ id: people.id })
            .from(people)
            .where(eq(people.email, primaryEmail))
            .limit(1)
        )[0]?.id ?? null)
      : await findOrCreatePersonId(db, primaryEmail, sentAt);
  const externals = externalsOnly(
    [...parsed.toList, ...parsed.cc].map((address) => address.email),
    input.ourDomains,
  );
  const conversationId = await computeConversationId(inbox, externals);
  const inReplyTo = parsed.headers["in-reply-to"]?.trim() || null;
  const threadKey = await threadKeyForNewMessage(db, {
    inbox,
    messageId: parsed.messageId,
    citedIds: citedIdsOf(inReplyTo, parsed.headers["references"]),
    mode: input.threadingMode,
  });

  const sentId = nanoid();
  const { kept, dropped } = keptAttachments(parsed.attachments);
  const bodyHtml = await storeAttachments(db, env, {
    emailId: sentId,
    kind: "sent",
    attachments: kept,
    bodyHtml: parsed.bodyHtml,
    now,
  });

  const row = {
    id: sentId,
    personId,
    fromAddress: inbox,
    toAddress: primaryEmail,
    subject: parsed.subject || "",
    bodyHtml: storedBody(bodyHtml),
    bodyText: storedBody(parsed.bodyText),
    inReplyTo,
    messageId: parsed.messageId,
    status: "sent" as const,
    cc: parsed.cc.length > 0 ? JSON.stringify(parsed.cc) : null,
    additionalTo: additionalTo.length > 0 ? JSON.stringify(additionalTo) : null,
    bcc: parsed.bcc.length > 0 ? JSON.stringify(parsed.bcc) : null,
    conversationId,
    threadKey,
    importJobId: input.importJobId ?? null,
    gmailMessageId: input.gmailMessageId ?? null,
    gmailThreadId: input.gmailThreadId ?? null,
    outlookMessageId: input.outlookMessageId ?? null,
    sentAt,
    createdAt: now,
  };
  let inserted: { id: string }[];
  try {
    inserted = await db
      .insert(sentEmails)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: sentEmails.id });
  } catch (error) {
    await discardStoredFiles(db, env, sentId, null);
    throw error;
  }
  if (inserted.length === 0) {
    // Already stored (a concurrent sync of the same message): the files
    // written above belong to no row.
    await discardStoredFiles(db, env, sentId, null);
    return {
      inserted: false,
      sentId,
      personId,
      conversationId,
      storedAttachments: [],
      droppedAttachments: 0,
    };
  }

  return {
    inserted: true,
    sentId,
    personId,
    conversationId,
    storedAttachments: kept,
    droppedAttachments: dropped,
  };
}
