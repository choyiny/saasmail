import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schema } from "./db/schema";
import { senders } from "./db/senders.schema";
import { emails } from "./db/emails.schema";
import { attachments } from "./db/attachments.schema";
import { parseEmail } from "./lib/email-parser";

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: CloudflareBindings,
  ctx: ExecutionContext
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

  // Upsert sender
  const existingSender = await db
    .select()
    .from(senders)
    .where(eq(senders.email, parsed.from.address))
    .limit(1);

  let senderId: string;

  if (existingSender.length > 0) {
    senderId = existingSender[0].id;
    await db
      .update(senders)
      .set({
        name: parsed.from.name || existingSender[0].name,
        lastEmailAt: now,
        unreadCount: existingSender[0].unreadCount + 1,
        totalCount: existingSender[0].totalCount + 1,
        updatedAt: now,
      })
      .where(eq(senders.id, senderId));
  } else {
    senderId = nanoid();
    await db.insert(senders).values({
      id: senderId,
      email: parsed.from.address,
      name: parsed.from.name || null,
      lastEmailAt: now,
      unreadCount: 1,
      totalCount: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Insert email
  const emailId = nanoid();
  await db.insert(emails).values({
    id: emailId,
    senderId,
    recipient: parsed.to,
    subject: parsed.subject,
    bodyHtml: parsed.bodyHtml,
    bodyText: parsed.bodyText,
    rawHeaders: JSON.stringify(parsed.headers),
    messageId: parsed.messageId,
    isRead: 0,
    receivedAt: now,
    createdAt: now,
  });

  // Process attachments
  for (const att of parsed.attachments) {
    const attachmentId = nanoid();
    const r2Key = `attachments/${emailId}/${att.filename}`;

    await env.R2.put(r2Key, att.content, {
      httpMetadata: { contentType: att.contentType },
    });

    await db.insert(attachments).values({
      id: attachmentId,
      emailId,
      filename: att.filename,
      contentType: att.contentType,
      size: att.content.byteLength,
      r2Key,
      createdAt: now,
    });
  }

  console.log(`Processed email from ${parsed.from.address} to ${parsed.to} (${parsed.attachments.length} attachments)`);
}
