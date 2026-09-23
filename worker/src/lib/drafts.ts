import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
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

export async function upsertDraft(
  db: DrizzleD1Database<any>,
  userId: string,
  input: DraftUpsertInput,
): Promise<typeof drafts.$inferSelect> {
  const now = Math.floor(Date.now() / 1000);
  const cc = input.cc ? JSON.stringify(input.cc) : null;

  await db
    .insert(drafts)
    .values({
      id: input.id ?? nanoid(),
      userId,
      contextKey: input.contextKey,
      fromAddress: input.fromAddress ?? null,
      toAddress: input.to ?? null,
      cc,
      subject: input.subject ?? null,
      bodyHtml: input.bodyHtml ?? null,
      bodyText: input.bodyText ?? null,
      replyToEmailId: input.replyToEmailId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [drafts.userId, drafts.contextKey],
      set: {
        fromAddress: input.fromAddress ?? null,
        toAddress: input.to ?? null,
        cc,
        subject: input.subject ?? null,
        bodyHtml: input.bodyHtml ?? null,
        bodyText: input.bodyText ?? null,
        replyToEmailId: input.replyToEmailId ?? null,
        updatedAt: now,
      },
    });

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
