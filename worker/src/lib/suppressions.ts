import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { schema } from "../db/schema";
import { suppressions } from "../db/suppressions.schema";
import { jsonList } from "./inbox-permissions";

export type Database = DrizzleD1Database<typeof schema>;

export async function isSuppressed(
  db: Database,
  email: string,
): Promise<boolean> {
  const row = await db.query.suppressions.findFirst({
    where: eq(suppressions.email, email.toLowerCase()),
    columns: { id: true },
  });
  return !!row;
}

/**
 * The addresses among `emails` that hard-bounced: these refuse even
 * transactional mail (docs/suppressions.md). One query, the list bound as
 * JSON, so any number of recipients stays one parameter.
 */
export async function hardBouncedAmong(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: DrizzleD1Database<any>,
  emails: readonly string[],
): Promise<string[]> {
  const wanted = [
    ...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.reason, "hard_bounce"),
        sql`${suppressions.email} IN ${jsonList(wanted)}`,
      ),
    );
  return rows.map((row) => row.email);
}
