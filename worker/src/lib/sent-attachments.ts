import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { attachments } from "../db/attachments.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import type { ParsedFile } from "./multipart-send";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** Staged attachments older than this with no send behind them are orphans. */
export const SENT_ATTACHMENT_ORPHAN_GRACE_SECONDS = 3600;

/**
 * Persist a send's attachments BEFORE the provider call, so the outbox retry
 * loader (which reads these rows) always finds them. D1 first (it records the
 * R2 keys, so a crash after it leaves something the reaper can find), then R2.
 * On an R2 failure everything staged so far is discarded and the error rethrown.
 * The discard waits for every put to settle: a put still in flight could land
 * after its row and key were deleted, leaving an object nothing tracks.
 */
export async function stageSentAttachments(
  db: Db,
  env: CloudflareBindings,
  sentEmailId: string,
  files: ParsedFile[],
  now: number,
): Promise<string[]> {
  if (files.length === 0) return [];
  const rows = files.map((file) => {
    const id = nanoid();
    return {
      id,
      r2Key: `attachments/sent/${sentEmailId}/${id}/${file.filename}`,
      file,
    };
  });
  await db.insert(attachments).values(
    rows.map((row) => ({
      id: row.id,
      emailId: sentEmailId,
      kind: "sent" as const,
      filename: row.file.filename,
      contentType: row.file.contentType,
      size: row.file.size,
      r2Key: row.r2Key,
      contentId: null,
      createdAt: now,
    })),
  );
  const puts = await Promise.allSettled(
    rows.map((row) =>
      env.R2.put(row.r2Key, row.file.bytes, {
        httpMetadata: { contentType: row.file.contentType },
      }),
    ),
  );
  const failed = puts.find(
    (put): put is PromiseRejectedResult => put.status === "rejected",
  );
  if (failed) {
    await discardSentAttachments(db, env, sentEmailId);
    throw failed.reason;
  }
  return rows.map((row) => row.id);
}

/**
 * Remove a send's staged attachments. R2 before D1 for each object: if the
 * Worker dies in between, the surviving row still names the key, so the
 * reaper retries the delete instead of leaking an untracked object.
 */
export async function discardSentAttachments(
  db: Db,
  env: CloudflareBindings,
  sentEmailId: string,
): Promise<void> {
  const rows = await db
    .select({ id: attachments.id, r2Key: attachments.r2Key })
    .from(attachments)
    .where(
      and(eq(attachments.emailId, sentEmailId), eq(attachments.kind, "sent")),
    );
  for (const row of rows) {
    await env.R2.delete(row.r2Key);
    await db.delete(attachments).where(eq(attachments.id, row.id));
  }
}

/**
 * Error path of a send. `sendViaOutbox` deletes its outbox row only when the
 * provider call itself throws; a D1 failure after that call leaves the row
 * pending, and its retry still needs the files. So discard only when no outbox
 * row references this send. A failed cleanup is logged and left to the reaper,
 * so it never replaces the send's own error.
 */
export async function discardSentAttachmentsUnlessQueued(
  db: Db,
  env: CloudflareBindings,
  sentEmailId: string,
): Promise<void> {
  try {
    const queued = await db
      .select({ id: outboxEmails.id })
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, sentEmailId))
      .limit(1);
    if (queued.length === 0) {
      await discardSentAttachments(db, env, sentEmailId);
    }
  } catch (err) {
    console.error(
      `[sent-attachments] cleanup after a failed send ${sentEmailId} failed:`,
      err,
    );
  }
}

/**
 * Cron: remove sent attachments staged by a send that never reached the
 * outbox (the Worker died between staging and the outbox insert). A send is
 * live while it has a sent_emails row or an outbox row; anything younger than
 * the grace period is left alone.
 */
export async function reapOrphanSentAttachments(
  db: Db,
  env: CloudflareBindings,
  now: number,
  graceSeconds = SENT_ATTACHMENT_ORPHAN_GRACE_SECONDS,
): Promise<number> {
  const cutoff = now - graceSeconds;
  const orphans = await db.all<{ id: string; r2_key: string }>(sql`
    SELECT a.id, a.r2_key
      FROM attachments a
     WHERE a.kind = 'sent'
       AND a.created_at < ${cutoff}
       AND NOT EXISTS (SELECT 1 FROM sent_emails s WHERE s.id = a.email_id)
       AND NOT EXISTS (SELECT 1 FROM outbox_emails o WHERE o.sent_email_id = a.email_id)
     LIMIT 500
  `);
  for (const orphan of orphans) {
    await env.R2.delete(orphan.r2_key);
    await db.delete(attachments).where(eq(attachments.id, orphan.id));
  }
  return orphans.length;
}
