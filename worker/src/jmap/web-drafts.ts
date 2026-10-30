// Shared drafts (spec 2026-09-28-shared-drafts, slice 1): the web composer's
// working copy (`drafts`) is published as a JMAP draft. JMAP content is
// immutable, so each publish is a new revision: create the new JMAP draft, link
// the working copy to it with a compare-and-set, then destroy the previous one.
// Publishing happens at coarse moments (composer close, 60 s idle), never per
// keystroke.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drafts } from "../db/drafts.schema";
import { emails } from "../db/emails.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createEmailSender } from "../lib/email-sender";
import {
  inboxFilter,
  isInboxAllowed,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import {
  contentLeaves,
  deleteContentIfUnreferenced,
  type ContentLeaf,
  type ContentPart,
} from "./content";
import { createDraftEmail, Rejection } from "./email-create";
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

/** A JMAP draft that is no longer a draft the web may replace. */
function isGoneDraft(
  draft:
    | Pick<typeof jmapDrafts.$inferSelect, "submitState" | "mailboxRole">
    | undefined,
): boolean {
  // Deleted, being sent (claimed or queued) or moved to Trash in a client.
  return !draft || draft.submitState !== null || draft.mailboxRole !== "drafts";
}

/**
 * Destroy a JMAP draft only while it is an idle draft in Drafts: the check and
 * the delete are one statement, so a client claiming it to send, or moving it
 * to Trash, always wins.
 */
async function destroyIfIdle(
  db: Db,
  env: CloudflareBindings,
  jmapDraftId: string,
): Promise<boolean> {
  const deleted = await env.DB.prepare(
    `DELETE FROM jmap_drafts
      WHERE id = ? AND submit_state IS NULL AND mailbox_role = 'drafts'
      RETURNING content_id`,
  )
    .bind(jmapDraftId)
    .first<{ content_id: string }>();
  if (!deleted) return false;
  try {
    await deleteContentIfUnreferenced(db, env, deleted.content_id);
  } catch (error) {
    // The draft is gone either way; content GC retries the cleanup.
    console.error(`[drafts] content cleanup for ${jmapDraftId} failed:`, error);
  }
  return true;
}

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
  // Spec S6, read live on every publish (never stored: a draft moved back out
  // of Trash, or whose send was undone, is a draft again).
  let previous: typeof jmapDrafts.$inferSelect | null = null;
  if (row.jmapDraftId) {
    [previous] = await db
      .select()
      .from(jmapDrafts)
      .where(
        and(eq(jmapDrafts.id, row.jmapDraftId), eq(jmapDrafts.userId, userId)),
      )
      .limit(1);
    if (isGoneDraft(previous)) return { status: "gone" };
  }
  if (!row.dirty && row.jmapDraftId) {
    return { status: "unchanged", jmapDraftId: row.jmapDraftId };
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
      WHERE id = ? AND jmap_draft_id IS ?`,
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
    if (fresh) await destroyIfIdle(db, env, fresh.id);
    const [current] = await db
      .select({ jmapDraftId: drafts.jmapDraftId })
      .from(drafts)
      .where(eq(drafts.id, row.id))
      .limit(1);
    return { status: "unchanged", jmapDraftId: current?.jmapDraftId ?? null };
  }
  // The previous revision goes, in one guarded statement. If it can't (a mail
  // client deleted, sent, claimed or trashed it while we published), the
  // client wins: the new revision goes and the copy points back at the old
  // one, so it reads as gone, and publishes again if that draft comes back
  // to Drafts. Never a resurrected or duplicated draft.
  if (previous && !(await destroyIfIdle(db, env, previous.id))) {
    await destroyIfIdle(db, env, newId);
    await db
      .update(drafts)
      .set({ jmapDraftId: previous.id, dirty: 1 })
      .where(and(eq(drafts.id, row.id), eq(drafts.jmapDraftId, newId)));
    return { status: "gone" };
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
  if (linked) await destroyIfIdle(db, env, linked.id);
}

/** The user's own JMAP draft, in Drafts, not being sent, in an allowed inbox. */
async function listedJmapDraft(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  jmapDraftId: string,
) {
  const [draft] = await db
    .select()
    .from(jmapDrafts)
    .where(and(eq(jmapDrafts.id, jmapDraftId), eq(jmapDrafts.userId, userId)))
    .limit(1);
  if (!draft || isGoneDraft(draft)) return null;
  if (!isInboxAllowed(allowed, draft.inbox)) return null;
  // A revision a web draft is linked to belongs to that draft, not the list.
  const [linked] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.jmapDraftId, draft.id)))
    .limit(1);
  if (linked) return null;
  return draft;
}

export type JmapDraftListItem = {
  id: string;
  contextKey: string;
  fromAddress: string;
  toAddress: string | null;
  subject: string | null;
  replyToEmailId: null;
  updatedAt: number;
};

/**
 * Drafts made in a mail client (no web working copy is linked to them): the
 * web lists them, read-only, as `jmap:<id>`.
 */
export async function listJmapOnlyDrafts(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  inbox: string | undefined,
): Promise<JmapDraftListItem[]> {
  // Inbox access is filtered in SQL, before the limit.
  const scope = inboxFilter(allowed, jmapDrafts.inbox);
  const rows = await db
    .select({
      id: jmapDrafts.id,
      inbox: jmapDrafts.inbox,
      updatedAt: jmapDrafts.updatedAt,
      toJson: jmapMessageContent.toJson,
      subject: jmapMessageContent.subject,
    })
    .from(jmapDrafts)
    .innerJoin(
      jmapMessageContent,
      eq(jmapMessageContent.id, jmapDrafts.contentId),
    )
    .where(
      and(
        eq(jmapDrafts.userId, userId),
        eq(jmapDrafts.mailboxRole, "drafts"),
        isNull(jmapDrafts.submitState),
        ...(inbox ? [eq(jmapDrafts.inbox, inbox)] : []),
        ...(scope ? [scope] : []),
        sql`NOT EXISTS (SELECT 1 FROM drafts d WHERE d.user_id = ${userId} AND d.jmap_draft_id = ${jmapDrafts.id})`,
      ),
    )
    .orderBy(desc(jmapDrafts.updatedAt))
    .limit(100);
  return rows.map((row) => {
    const to = JSON.parse(row.toJson) as { email: string }[];
    return {
      id: `jmap:${row.id}`,
      contextKey: `jmap:${row.id}`,
      fromAddress: row.inbox,
      toAddress: to.map((address) => address.email).join(", ") || null,
      subject: row.subject || null,
      replyToEmailId: null,
      updatedAt: row.updatedAt,
    };
  });
}

export type JmapDraftPreview = {
  contextKey: string;
  from: { email: string; name: string | null } | null;
  to: { email: string; name: string | null }[];
  cc: { email: string; name: string | null }[];
  bcc: { email: string; name: string | null }[];
  subject: string;
  /** The first HTML body part, or null; the web sanitises it to show it. */
  html: string | null;
  text: string | null;
  attachments: { name: string | null; type: string; size: number }[];
  updatedAt: number;
};

/** A mail-client draft, read-only, for the web's preview. */
export async function previewJmapDraft(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  jmapDraftId: string,
): Promise<JmapDraftPreview | null> {
  const draft = await listedJmapDraft(db, allowed, userId, jmapDraftId);
  if (!draft) return null;
  const [content] = await db
    .select()
    .from(jmapMessageContent)
    .where(eq(jmapMessageContent.id, draft.contentId))
    .limit(1);
  if (!content) return null;
  const values = JSON.parse(content.bodyValuesJson) as Record<string, string>;
  const leaves = new Map(
    contentLeaves(JSON.parse(content.partsJson) as ContentPart).map((leaf) => [
      leaf.partId,
      leaf,
    ]),
  );
  const first = (ids: string[], type: string) => {
    const leaf = ids
      .map((id) => leaves.get(id))
      .find((candidate) => candidate?.type === type);
    return leaf ? (values[leaf.partId] ?? null) : null;
  };
  const addresses = (json: string) =>
    JSON.parse(json) as { email: string; name: string | null }[];
  return {
    contextKey: `jmap:${draft.id}`,
    from: addresses(content.fromJson)[0] ?? null,
    to: addresses(content.toJson),
    cc: addresses(content.ccJson),
    bcc: addresses(content.bccJson),
    subject: content.subject,
    html: first(JSON.parse(content.htmlBodyJson) as string[], "text/html"),
    text: first(JSON.parse(content.textBodyJson) as string[], "text/plain"),
    attachments: (JSON.parse(content.attachmentsJson) as string[])
      .map((partId) => leaves.get(partId))
      .filter((leaf): leaf is ContentLeaf => leaf !== undefined)
      .map((leaf) => ({ name: leaf.name, type: leaf.type, size: leaf.size })),
    updatedAt: draft.updatedAt,
  };
}

/** Delete a mail-client draft from the web list. */
export async function destroyJmapDraftFromWeb(
  db: Db,
  env: CloudflareBindings,
  allowed: AllowedInboxes,
  userId: string,
  jmapDraftId: string,
): Promise<void> {
  const draft = await listedJmapDraft(db, allowed, userId, jmapDraftId);
  if (draft) await destroyIfIdle(db, env, draft.id);
}
