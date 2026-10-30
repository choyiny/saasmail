import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { drafts } from "../db/drafts.schema";

export type DraftCcEntry = {
  email: string;
  name?: string | null;
};

export type DraftUpsertInput = {
  id?: string;
  contextKey: string;
  fromAddress?: string;
  to?: string;
  cc?: DraftCcEntry[];
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  replyToEmailId?: string | null;
};

export async function getDraft(
  db: DrizzleD1Database<any>,
  userId: string,
  contextKey: string,
): Promise<typeof drafts.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.contextKey, contextKey)))
    .limit(1);
  return row ?? null;
}

/** Empty text is no value: '' and null compare equal after this. */
function textOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

export async function upsertDraft(
  db: DrizzleD1Database<any>,
  userId: string,
  input: DraftUpsertInput,
): Promise<typeof drafts.$inferSelect> {
  const now = Math.floor(Date.now() / 1000);
  // Normalised ('' and [] store as null), so a save that repeats what the
  // draft already holds changes nothing.
  const cc = input.cc && input.cc.length > 0 ? JSON.stringify(input.cc) : null;
  const fromAddress = textOrNull(input.fromAddress?.trim().toLowerCase());

  // Shared drafts: `dirty` (the next publish makes a new JMAP revision) only
  // when a field really changed, so opening and closing a draft, or a save
  // with the same values, makes no revision. One statement: `drafts.*` is
  // the old row, `excluded.*` the new values.
  await db.run(sql`
    INSERT INTO drafts (id, user_id, context_key, from_address, to_address, cc, subject,
                        body_html, body_text, reply_to_email_id, dirty, created_at, updated_at)
    VALUES (${input.id ?? nanoid()}, ${userId}, ${input.contextKey}, ${fromAddress},
            ${textOrNull(input.to)}, ${cc}, ${textOrNull(input.subject)},
            ${textOrNull(input.bodyHtml)}, ${textOrNull(input.bodyText)},
            ${textOrNull(input.replyToEmailId)}, 1, ${now}, ${now})
    ON CONFLICT (user_id, context_key) DO UPDATE SET
      from_address = excluded.from_address,
      to_address = excluded.to_address,
      cc = excluded.cc,
      subject = excluded.subject,
      body_html = excluded.body_html,
      body_text = excluded.body_text,
      reply_to_email_id = excluded.reply_to_email_id,
      dirty = CASE WHEN drafts.from_address IS excluded.from_address
                    AND drafts.to_address IS excluded.to_address
                    AND drafts.cc IS excluded.cc
                    AND drafts.subject IS excluded.subject
                    AND drafts.body_html IS excluded.body_html
                    AND drafts.body_text IS excluded.body_text
                    AND drafts.reply_to_email_id IS excluded.reply_to_email_id
               THEN drafts.dirty ELSE 1 END,
      updated_at = excluded.updated_at
  `);

  const [row] = await db
    .select()
    .from(drafts)
    .where(
      and(eq(drafts.userId, userId), eq(drafts.contextKey, input.contextKey)),
    )
    .limit(1);

  if (!row) {
    throw new Error("Draft upsert did not return a row");
  }
  return row;
}
