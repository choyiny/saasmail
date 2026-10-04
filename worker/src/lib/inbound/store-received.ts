import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { attachments } from "../../db/attachments.schema";
import { emails } from "../../db/emails.schema";
import { people } from "../../db/people.schema";
import { computeConversationId, externalsOnly } from "../conversation-id";
import type { ParsedAttachment, ParsedEmail } from "../email-parser";
import { sanitizeFilename } from "../sanitize-filename";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export const MAX_ATTACHMENTS = 50;
/**
 * Imported bodies are cut to this many characters for storage: D1 takes at
 * most 2 MB per row. The whole message stays in R2 (`raw_r2_key`).
 */
export const MAX_IMPORTED_BODY_CHARS = 250_000;

/** A body cut for storage, when it is longer than an import keeps. */
export function storedBody(value: string | null): string | null {
  return value && value.length > MAX_IMPORTED_BODY_CHARS
    ? value.slice(0, MAX_IMPORTED_BODY_CHARS)
    : value;
}
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

/** The domains of our inboxes: participants there are the team, not customers. */
export function domainsOf(addresses: string[]): string[] {
  return Array.from(
    new Set(
      addresses
        .map((address) => {
          const at = address.lastIndexOf("@");
          return at === -1 ? "" : address.slice(at + 1).toLowerCase();
        })
        .filter(Boolean),
    ),
  );
}

/**
 * The attachments a message keeps: the first 50, until they add up to 25 MB.
 * `dropped` counts the rest.
 */
export function keptAttachments(list: ParsedAttachment[]): {
  kept: ParsedAttachment[];
  dropped: number;
} {
  const kept: ParsedAttachment[] = [];
  let total = 0;
  for (const attachment of list.slice(0, MAX_ATTACHMENTS)) {
    total += attachment.content.byteLength;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) break;
    kept.push(attachment);
  }
  return { kept, dropped: list.length - kept.length };
}

/**
 * Writes a message's attachments to R2 and D1 under `emailId` and rewrites
 * the HTML body's `cid:` references to their inline URLs.
 */
export async function storeAttachments(
  db: Db,
  env: CloudflareBindings,
  input: {
    emailId: string;
    kind: "inbound" | "sent";
    attachments: ParsedAttachment[];
    bodyHtml: string | null;
    now: number;
  },
): Promise<string | null> {
  const cidMap: Record<string, string> = {};
  for (const att of input.attachments) {
    const safeFilename = sanitizeFilename(att.filename);
    const attachmentId = nanoid();
    const r2Key =
      input.kind === "sent"
        ? `attachments/sent/${input.emailId}/${attachmentId}/${safeFilename}`
        : `attachments/${input.emailId}/${attachmentId}/${safeFilename}`;

    await env.R2.put(r2Key, att.content, {
      httpMetadata: { contentType: att.contentType },
    });

    const isInline = att.disposition === "inline" && !!att.contentId;

    await db.insert(attachments).values({
      id: attachmentId,
      emailId: input.emailId,
      kind: input.kind,
      filename: safeFilename,
      contentType: att.contentType,
      size: att.content.byteLength,
      r2Key,
      contentId: isInline ? att.contentId : null,
      createdAt: input.now,
    });

    if (isInline && att.contentId) {
      const cleanCid = att.contentId.replace(/^<|>$/g, "");
      cidMap[cleanCid] = attachmentId;
    }
  }

  // Rewrite CID references in HTML body
  let bodyHtml = input.bodyHtml;
  if (bodyHtml && Object.keys(cidMap).length > 0) {
    for (const [cid, attachmentId] of Object.entries(cidMap)) {
      bodyHtml = bodyHtml.replace(
        new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"),
        `/api/attachments/${attachmentId}/inline`,
      );
    }
  }
  return bodyHtml;
}

/**
 * Removes the attachments (rows and R2 objects) and the raw message stored
 * for a message whose row was then not written. Best-effort.
 */
export async function discardStoredFiles(
  db: Db,
  env: CloudflareBindings,
  emailId: string,
  rawKey: string | null,
): Promise<void> {
  try {
    const rows = await db
      .select({ r2Key: attachments.r2Key })
      .from(attachments)
      .where(eq(attachments.emailId, emailId));
    const keys = [...rows.map((row) => row.r2Key), ...(rawKey ? [rawKey] : [])];
    if (keys.length > 0) await env.R2.delete(keys);
    await db.delete(attachments).where(eq(attachments.emailId, emailId));
  } catch (error) {
    console.warn(`[import] files of ${emailId} not discarded:`, error);
  }
}

export interface StoreReceivedInput {
  parsed: ParsedEmail;
  /** Canonical (lowercased) inbox address. */
  inbox: string;
  /** Canonical (lowercased) sender address. */
  fromAddress: string;
  receivedAt: number;
  now: number;
  /**
   * `inbound`: live mail, unread, counted as unread for its person.
   * `import`: history, read, counted only in the person's total, and never
   * moving their last activity back in time.
   */
  source: "inbound" | "import";
  /** Domains of our inboxes (see `domainsOf`). */
  ourDomains: string[];
  /** The inbox's learning filter's score; live mail only. */
  spamProbability?: number | null;
  /** The import storing it; recorded on the row. */
  importJobId?: string | null;
}

export interface StoredReceived {
  emailId: string;
  personId: string;
  conversationId: string | null;
  /** The HTML body as stored, `cid:` references rewritten. */
  bodyHtml: string | null;
  /** The attachments stored; the rest went over the limits. */
  storedAttachments: ParsedAttachment[];
  droppedAttachments: number;
}

/**
 * Stores a received message the way live mail is stored: the sender's person
 * row, the attachments (with `cid:` rewriting), the conversation id, the raw
 * bytes for JMAP, and the `emails` row. Used by the inbound handler and the
 * mail importer, so imported mail threads and renders like live mail.
 */
export async function storeReceivedMessage(
  db: Db,
  env: CloudflareBindings,
  input: StoreReceivedInput,
): Promise<StoredReceived> {
  const { parsed, inbox, fromAddress, receivedAt, now } = input;
  const imported = input.source === "import";

  const senderAuthenticated =
    parsed.auth.spf === "pass" ||
    parsed.auth.dkim === "pass" ||
    parsed.auth.dmarc === "pass";
  const name = parsed.from.name || null;

  if (imported) {
    // The person without counting yet: the count goes up with the message
    // row, in one batch, so a retried import never counts a message twice.
    // An import only fills a missing name: an old message must not rename
    // them.
    await db
      .insert(people)
      .values({
        id: nanoid(),
        email: fromAddress,
        name,
        lastEmailAt: receivedAt,
        unreadCount: 0,
        totalCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: people.email,
        set: {
          ...(senderAuthenticated
            ? { name: sql`COALESCE(${people.name}, ${name})` }
            : {}),
          updatedAt: now,
        },
      });
  } else {
    // Upsert person — only update name if sender passes authentication
    await db
      .insert(people)
      .values({
        id: nanoid(),
        email: fromAddress,
        name,
        lastEmailAt: receivedAt,
        unreadCount: 1,
        totalCount: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: people.email,
        set: {
          ...(senderAuthenticated
            ? { name: sql`COALESCE(${name}, ${people.name})` }
            : {}),
          lastEmailAt: receivedAt,
          unreadCount: sql`${people.unreadCount} + 1`,
          totalCount: sql`${people.totalCount} + 1`,
          updatedAt: now,
        },
      });
  }

  // Get the actual person ID (could be existing). Lookup by the
  // canonical (lowercased) email so legacy mixed-case rows still
  // resolve to the same person.
  const personRow = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, fromAddress))
    .limit(1);
  const personId = personRow[0]!.id;

  // Process attachments first (need IDs for CID rewriting)
  const emailId = nanoid();
  const { kept, dropped } = keptAttachments(parsed.attachments);
  if (dropped > 0) {
    console.log(
      `Attachment limits exceeded for email from ${parsed.from.address}, skipping ${dropped}`,
    );
  }
  const bodyHtml = await storeAttachments(db, env, {
    emailId,
    kind: "inbound",
    attachments: kept,
    bodyHtml: parsed.bodyHtml,
    now,
  });

  // Compute the conversation_id, if this is a multi-participant thread.
  // External participants = the sender + everyone on the Cc line, minus
  // any addresses that match one of our sender_identities (those are
  // "internal" team members and don't change the group identity).
  const externals = externalsOnly(
    [fromAddress, ...parsed.cc.map((c) => c.email)],
    input.ourDomains,
  );
  const conversationId = await computeConversationId(inbox, externals);

  // The message exactly as received, for JMAP's blobId. Written before the row
  // so a new Email never gains a blobId after a client has seen it; a failed
  // write stores the mail without one rather than losing it.
  let rawR2Key: string | null = `inbound-raw/${emailId}.eml`;
  try {
    await env.R2.put(rawR2Key, parsed.raw, {
      httpMetadata: { contentType: "message/rfc822" },
    });
  } catch (err) {
    console.error(`[inbound] raw message not stored for ${emailId}:`, err);
    rawR2Key = null;
  }

  // Insert email (with rewritten HTML and auth results). Store the
  // canonical (lowercased) recipient so it matches the conversation
  // group key.
  const row = {
    id: emailId,
    personId,
    recipient: inbox,
    subject: parsed.subject,
    bodyHtml: imported ? storedBody(bodyHtml) : bodyHtml,
    bodyText: imported ? storedBody(parsed.bodyText) : parsed.bodyText,
    rawHeaders: JSON.stringify(parsed.headers),
    messageId: parsed.messageId,
    // postal-mime keys headers in lowercase; JMAP exposes these as
    // inReplyTo/references.
    inReplyTo: parsed.headers["in-reply-to"]?.trim() || null,
    referencesHeader: parsed.headers["references"]?.trim() || null,
    rawR2Key,
    rawSize: rawR2Key ? parsed.raw.byteLength : null,
    spf: parsed.auth.spf,
    dkim: parsed.auth.dkim,
    dmarc: parsed.auth.dmarc,
    spamScore: parsed.spamScore,
    spamProbability: imported ? null : (input.spamProbability ?? null),
    isRead: imported ? 1 : 0,
    cc: parsed.cc.length > 0 ? JSON.stringify(parsed.cc) : null,
    replyTo: parsed.replyTo.length ? JSON.stringify(parsed.replyTo) : null,
    conversationId,
    importJobId: imported ? (input.importJobId ?? null) : null,
    receivedAt,
    createdAt: now,
  };
  if (imported) {
    try {
      await db.batch([
        db.insert(emails).values(row),
        db
          .update(people)
          .set({
            totalCount: sql`${people.totalCount} + 1`,
            lastEmailAt: sql`MAX(${people.lastEmailAt}, ${receivedAt})`,
            updatedAt: now,
          })
          .where(eq(people.id, personId)),
      ]);
    } catch (error) {
      // Nothing of a message that was not stored stays behind.
      await discardStoredFiles(db, env, emailId, rawR2Key);
      throw error;
    }
  } else {
    await db.insert(emails).values(row);
  }

  return {
    emailId,
    personId,
    conversationId,
    bodyHtml,
    storedAttachments: kept,
    droppedAttachments: dropped,
  };
}
