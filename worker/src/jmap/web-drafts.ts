// Shared drafts (spec 2026-09-28-shared-drafts, slice 1): the web composer's
// working copy (`drafts`) is published as a JMAP draft. JMAP content is
// immutable, so each publish is a new revision: create the new JMAP draft, link
// the working copy to it with a compare-and-set, then destroy the previous one.
// Publishing happens at coarse moments (composer close, 60 s idle), never per
// keystroke.
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drafts } from "../db/drafts.schema";
import { emails } from "../db/emails.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createEmailSender } from "../lib/email-sender";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { createDraftEmail, Rejection } from "./email-create";
import { destroyDraft } from "./drafts";
import { listUsableIdentities } from "./mailboxes";
import {
  parseDraftEmailId,
  publicCustomMailboxId,
  publicSystemMailboxId,
} from "./public-ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;
type WorkingCopy = typeof drafts.$inferSelect;

export type PublishOutcome =
  /** A new revision is the JMAP draft now. */
  | { status: "published"; jmapDraftId: string }
  /** Nothing changed since the last publish. */
  | { status: "unchanged"; jmapDraftId: string | null }
  /** Not publishable yet (no From, an incomplete To, …); stays dirty. */
  | { status: "skipped"; reason: string }
  /** Its JMAP draft was sent or deleted elsewhere; publishing stopped. */
  | { status: "gone" }
  /** No working copy for this surface. */
  | { status: "notFound" };

/** The bare `id` of a `<id>` Message-ID header value. */
function bareMessageId(value: string | null): string | null {
  const trimmed = value?.trim().replace(/^<|>$/g, "") ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The web reply's threading, as `replyToEmail` sends it: In-Reply-To and
 * References are the original's Message-ID (received or sent).
 */
async function replyThreading(
  db: Db,
  replyToEmailId: string | null,
): Promise<string | null> {
  if (!replyToEmailId) return null;
  const [received] = await db
    .select({ messageId: emails.messageId })
    .from(emails)
    .where(eq(emails.id, replyToEmailId))
    .limit(1);
  if (received) return bareMessageId(received.messageId);
  const [sent] = await db
    .select({ messageId: sentEmails.messageId })
    .from(sentEmails)
    .where(eq(sentEmails.id, replyToEmailId))
    .limit(1);
  return sent ? bareMessageId(sent.messageId) : null;
}

function parseCc(
  value: string | null,
): { email: string; name?: string | null }[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The Email/set create a working copy publishes as, or why it can't yet. */
async function createInput(
  db: Db,
  allowed: AllowedInboxes,
  row: WorkingCopy,
  previous: typeof jmapDrafts.$inferSelect | null,
): Promise<{ input: Record<string, unknown> | null; reason: string | null }> {
  const from = row.fromAddress?.trim().toLowerCase();
  // Spec S7: a draft with no From isn't published until it has one.
  if (!from) return { input: null, reason: "no From yet" };
  const identity = (await listUsableIdentities(db, allowed)).find(
    (candidate) => candidate.email.trim().toLowerCase() === from,
  );
  if (!identity) return { input: null, reason: "From isn't a usable identity" };

  const to = row.toAddress?.trim() ?? "";
  const cc = parseCc(row.cc)
    .map((entry) => ({
      email: entry.email.trim(),
      ...(entry.name ? { name: entry.name } : {}),
    }))
    .filter((entry) => entry.email.length > 0);
  const html = row.bodyHtml ?? "";
  const text = row.bodyText ?? "";
  const bodyValues: Record<string, { value: string }> = {};
  const textBody: Record<string, unknown>[] = [];
  const htmlBody: Record<string, unknown>[] = [];
  if (text.length > 0 || html.length === 0) {
    bodyValues.t = { value: text };
    textBody.push({ partId: "t", type: "text/plain" });
  }
  if (html.length > 0) {
    bodyValues.h = { value: html };
    htmlBody.push({ partId: "h", type: "text/html" });
  }

  const mailboxIds: Record<string, true> = {
    [publicSystemMailboxId(from, "drafts")]: true,
  };
  // A new revision stays in the custom folders the last one was filed in.
  if (previous) {
    for (const folder of JSON.parse(previous.folderIds) as string[]) {
      mailboxIds[publicCustomMailboxId(folder)] = true;
    }
  }
  const keywords: Record<string, true> = { $draft: true, $seen: true };
  if (previous?.flagged) keywords.$flagged = true;

  const inReplyTo = await replyThreading(db, row.replyToEmailId);
  return {
    input: {
      mailboxIds,
      keywords,
      from: [
        {
          email: from,
          ...(identity.displayName ? { name: identity.displayName } : {}),
        },
      ],
      to: to.length > 0 ? [{ email: to }] : [],
      cc,
      subject: row.subject ?? "",
      ...(inReplyTo ? { inReplyTo: [inReplyTo], references: [inReplyTo] } : {}),
      bodyValues,
      textBody,
      htmlBody,
    },
    reason: null,
  };
}

/**
 * Publish one working copy (by compose surface) as a new JMAP draft revision.
 * Idempotent and safe to race: only the publish whose compare-and-set links it
 * keeps its revision; a loser destroys what it created.
 */
export async function publishWebDraft(
  db: Db,
  env: CloudflareBindings,
  allowed: AllowedInboxes,
  userId: string,
  contextKey: string,
): Promise<PublishOutcome> {
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.contextKey, contextKey)))
    .limit(1);
  if (!row) return { status: "notFound" };
  if (row.jmapState === "gone") return { status: "gone" };
  if (!row.dirty && row.jmapDraftId) {
    return { status: "unchanged", jmapDraftId: row.jmapDraftId };
  }

  let previous: typeof jmapDrafts.$inferSelect | null = null;
  if (row.jmapDraftId) {
    [previous] = await db
      .select()
      .from(jmapDrafts)
      .where(
        and(eq(jmapDrafts.id, row.jmapDraftId), eq(jmapDrafts.userId, userId)),
      )
      .limit(1);
    // Spec S6: sent (it was claimed or filed into Sent) or deleted elsewhere.
    if (!previous || previous.submitState !== null) {
      await db
        .update(drafts)
        .set({ jmapState: "gone" })
        .where(eq(drafts.id, row.id));
      return { status: "gone" };
    }
  }

  const { input, reason } = await createInput(db, allowed, row, previous);
  if (!input) return { status: "skipped", reason: reason! };
  const now = Math.floor(Date.now() / 1000);
  const created = await createDraftEmail(
    {
      db,
      env,
      allowed,
      userId,
      maxAttachmentBytes: createEmailSender(env).maxAttachmentBytes(),
      now,
    },
    input,
  );
  if (created instanceof Rejection) {
    // An address still being typed, a subject too long, …: try again later.
    return {
      status: "skipped",
      reason: `invalid ${(created.error.properties ?? []).join(", ") || created.error.type}`,
    };
  }
  const newId = parseDraftEmailId(created.id)!;

  // Link with a compare-and-set on the revision we replaced; clear `dirty` only
  // if nothing was saved while we published.
  const result = await env.DB.prepare(
    `UPDATE drafts
        SET jmap_draft_id = ?,
            dirty = CASE WHEN from_address IS ? AND to_address IS ? AND cc IS ? AND subject IS ?
                               AND body_html IS ? AND body_text IS ? AND reply_to_email_id IS ?
                         THEN 0 ELSE 1 END
      WHERE id = ? AND jmap_draft_id IS ? AND jmap_state IS NULL`,
  )
    .bind(
      newId,
      row.fromAddress,
      row.toAddress,
      row.cc,
      row.subject,
      row.bodyHtml,
      row.bodyText,
      row.replyToEmailId,
      row.id,
      row.jmapDraftId,
    )
    .run();
  const [fresh] = await db
    .select()
    .from(jmapDrafts)
    .where(eq(jmapDrafts.id, newId))
    .limit(1);
  if ((result.meta.changes ?? 0) === 0) {
    // Another publish linked first: ours is a duplicate.
    if (fresh) await destroyDraft(db, env, fresh);
    const [current] = await db
      .select({ jmapDraftId: drafts.jmapDraftId })
      .from(drafts)
      .where(eq(drafts.id, row.id))
      .limit(1);
    return { status: "unchanged", jmapDraftId: current?.jmapDraftId ?? null };
  }
  // The previous revision goes, unless a submission claimed it meanwhile.
  if (previous) {
    const [still] = await db
      .select()
      .from(jmapDrafts)
      .where(eq(jmapDrafts.id, previous.id))
      .limit(1);
    if (still && still.submitState === null) {
      await destroyDraft(db, env, still);
    }
  }
  return { status: "published", jmapDraftId: newId };
}

/**
 * Deleting a web draft deletes the shared draft: its JMAP draft goes too,
 * unless a submission is sending it.
 */
export async function destroyLinkedJmapDraft(
  db: Db,
  env: CloudflareBindings,
  row: Pick<WorkingCopy, "jmapDraftId" | "userId">,
): Promise<void> {
  if (!row.jmapDraftId) return;
  const [linked] = await db
    .select()
    .from(jmapDrafts)
    .where(
      and(
        eq(jmapDrafts.id, row.jmapDraftId),
        eq(jmapDrafts.userId, row.userId),
      ),
    )
    .limit(1);
  if (linked && linked.submitState === null) {
    await destroyDraft(db, env, linked);
  }
}
