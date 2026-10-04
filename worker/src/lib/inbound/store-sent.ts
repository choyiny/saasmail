import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { sentEmails } from "../../db/sent-emails.schema";
import { computeConversationId, externalsOnly } from "../conversation-id";
import type { ParsedAttachment, ParsedEmail } from "../email-parser";
import { findOrCreatePersonId } from "../sent-bookkeeping";
import {
  discardStoredFiles,
  keptAttachments,
  storeAttachments,
  storedBody,
} from "./store-received";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export interface StoredSent {
  sentId: string;
  personId: string;
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
  },
): Promise<StoredSent | null> {
  const { parsed, inbox, sentAt, now } = input;
  const recipients = [...parsed.toList, ...parsed.cc, ...parsed.bcc];
  const primary = recipients[0];
  if (!primary) return null;
  const additionalTo = parsed.toList.filter(
    (address) => address.email !== primary.email,
  );

  const personId = await findOrCreatePersonId(db, primary.email, sentAt);
  const externals = externalsOnly(
    [...parsed.toList, ...parsed.cc].map((address) => address.email),
    input.ourDomains,
  );
  const conversationId = await computeConversationId(inbox, externals);

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
    toAddress: primary.email,
    subject: parsed.subject || "",
    bodyHtml: storedBody(bodyHtml),
    bodyText: storedBody(parsed.bodyText),
    inReplyTo: parsed.headers["in-reply-to"]?.trim() || null,
    messageId: parsed.messageId,
    status: "sent" as const,
    cc: parsed.cc.length > 0 ? JSON.stringify(parsed.cc) : null,
    additionalTo: additionalTo.length > 0 ? JSON.stringify(additionalTo) : null,
    bcc: parsed.bcc.length > 0 ? JSON.stringify(parsed.bcc) : null,
    conversationId,
    importJobId: input.importJobId ?? null,
    sentAt,
    createdAt: now,
  };
  try {
    await db.insert(sentEmails).values(row);
  } catch (error) {
    await discardStoredFiles(db, env, sentId, null);
    throw error;
  }

  return {
    sentId,
    personId,
    conversationId,
    storedAttachments: kept,
    droppedAttachments: dropped,
  };
}
