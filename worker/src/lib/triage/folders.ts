import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { mailboxes } from "../../db/mailboxes.schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** The colours a custom folder may have. */
export const MAILBOX_COLORS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "violet",
  "purple",
  "pink",
] as const;
export type MailboxColor = (typeof MAILBOX_COLORS)[number];

/** Folders per inbox the AI may file into, and the length of a description. */
export const MAX_AI_FOLDERS = 30;
export const MAX_AI_DESCRIPTION = 300;

export class TooManyAiFoldersError extends Error {
  readonly code = "TOO_MANY_AI_FOLDERS";
  constructor() {
    super(
      `An inbox can have at most ${MAX_AI_FOLDERS} folders with a description for AI filing`,
    );
    this.name = "TooManyAiFoldersError";
  }
}

/** A trimmed description, or null for none. */
export function normalizeAiDescription(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Refuses a description that would give the inbox more than the allowed
 * number of described folders. `exceptId` is the folder being changed.
 */
export async function assertAiFolderRoom(
  db: Db,
  inbox: string,
  exceptId: string | null,
): Promise<void> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.inbox, inbox),
        isNotNull(mailboxes.aiDescription),
        exceptId ? ne(mailboxes.id, exceptId) : undefined,
      ),
    );
  if (Number(row?.n ?? 0) >= MAX_AI_FOLDERS) throw new TooManyAiFoldersError();
}

/** An inbox's folders the AI may file into, in rail order. */
export async function describedFolders(
  db: Db,
  inbox: string,
): Promise<{ id: string; name: string; description: string }[]> {
  const rows = await db
    .select({
      id: mailboxes.id,
      name: mailboxes.name,
      description: mailboxes.aiDescription,
    })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.inbox, inbox.trim().toLowerCase()),
        isNotNull(mailboxes.aiDescription),
      ),
    )
    .orderBy(mailboxes.sortOrder, mailboxes.name)
    .limit(MAX_AI_FOLDERS);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? "",
  }));
}
