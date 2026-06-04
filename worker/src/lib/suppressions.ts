import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { schema } from "../db/schema";
import { suppressions } from "../db/suppressions.schema";

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
