import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
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

/**
 * Record addresses the email provider refused as permanently undeliverable
 * (on the provider's own suppression list). `source` is the provider name, so
 * the admin suppressions view shows where each entry came from. An address
 * already suppressed for any reason is left as it is.
 */
export async function recordProviderSuppressions(
  db: Database,
  emails: string[],
  source: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()))];
  for (const email of unique) {
    await db
      .insert(suppressions)
      .values({
        id: nanoid(),
        email,
        reason: "provider",
        source,
        createdAt: now,
      })
      .onConflictDoNothing({ target: suppressions.email });
  }
}
