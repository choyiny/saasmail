import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { people } from "../db/people.schema";

type Db = ReturnType<typeof drizzle>;

/**
 * Resolve an email address to an existing `people.id`, or `null`.
 *
 * Deliberately **read-only**. The campaign send path calls this per recipient
 * to populate `contacts.person_id`, and it must never create the row: a
 * find-or-create here would insert one `people` row per recipient — up to
 * 10,000 on a single blast — which is exactly the inbox pollution the separate
 * `contacts` table exists to prevent. Subscribers who are already
 * correspondents get linked; the rest stay unlinked until they actually
 * correspond, at which point the inbound handler or a transactional send
 * creates the row and the hourly backfill picks it up.
 *
 * See SPEC.md Decision 23. The find-or-*create* pattern still lives inline in
 * `lib/send-email.ts`, where creating a person is the correct behaviour.
 */
export async function findPersonIdByEmail(
  db: Db,
  email: string,
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (normalized === "") return null;

  const rows = await db
    .select({ id: people.id })
    .from(people)
    // `people.email` is stored lowercased by every existing write path, but
    // subscriber input arrives raw, so compare on a lowered column rather than
    // trusting the caller to have normalized.
    .where(eq(sql`lower(${people.email})`, normalized))
    .limit(1);

  return rows[0]?.id ?? null;
}
