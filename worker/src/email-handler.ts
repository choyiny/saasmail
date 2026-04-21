import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schema } from "./db/schema";
import { people } from "./db/people.schema";
import { emails } from "./db/emails.schema";
import { attachments } from "./db/attachments.schema";
import { parseEmail } from "./lib/email-parser";
import { cancelSequencesForPerson } from "./lib/cancel-sequence";

const MAX_ATTACHMENTS = 50;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Strip path traversal sequences and dangerous characters from filenames.
 */
function sanitizeFilename(filename: string): string {
  return (
    filename
      .replace(/\.\.[/\\]/g, "") // strip path traversal
      .replace(/[/\\]/g, "_") // replace path separators
      .replace(/[\x00-\x1f]/g, "") // strip control characters
      .slice(0, 255) || // limit length
    "unnamed"
  );
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: CloudflareBindings,
  ctx: ExecutionContext,
): Promise<void> {
  const db = drizzle(env.DB, { schema, logger: true });
  const parsed = await parseEmail(message);
  const now = Math.floor(Date.now() / 1000);

  // Deduplicate by Message-ID
  if (parsed.messageId) {
    const existing = await db
      .select({ id: emails.id })
      .from(emails)
      .where(eq(emails.messageId, parsed.messageId))
      .limit(1);
    if (existing.length > 0) {
      console.log(`Duplicate email with Message-ID: ${parsed.messageId}`);
      return;
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
      email: parsed.from.address,
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

  // Get the actual person ID (could be existing)
  const personRow = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, parsed.from.address))
    .limit(1);
  const actualPersonId = personRow[0]!.id;

  // Process attachments first (need IDs for CID rewriting)
  const cidMap: Record<string, string> = {};
  const emailId = nanoid();

  // Enforce attachment limits
  const cappedAttachments = parsed.attachments.slice(0, MAX_ATTACHMENTS);
  let totalAttachmentBytes = 0;

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
    const r2Key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;

    await env.R2.put(r2Key, att.content, {
      httpMetadata: { contentType: att.contentType },
    });

    const isInline = att.disposition === "inline" && !!att.contentId;

    await db.insert(attachments).values({
      id: attachmentId,
      emailId,
      filename: safeFilename,
      contentType: att.contentType,
      size: att.content.byteLength,
      r2Key,
      contentId: isInline ? att.contentId : null,
      createdAt: now,
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

  // Insert email (with rewritten HTML and auth results)
  await db.insert(emails).values({
    id: emailId,
    personId: actualPersonId,
    recipient: parsed.to,
    subject: parsed.subject,
    bodyHtml,
    bodyText: parsed.bodyText,
    rawHeaders: JSON.stringify(parsed.headers),
    messageId: parsed.messageId,
    spf: parsed.auth.spf,
    dkim: parsed.auth.dkim,
    dmarc: parsed.auth.dmarc,
    isRead: 0,
    receivedAt: now,
    createdAt: now,
  });

  // Cancel any active sequences for this person
  await cancelSequencesForPerson(db, actualPersonId);

  console.log(
    `Processed email from ${parsed.from.address} to ${parsed.to} (${parsed.attachments.length} attachments)`,
  );
}
