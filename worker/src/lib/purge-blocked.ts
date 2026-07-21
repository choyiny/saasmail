import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { people } from "../db/people.schema";
import { deleteEmailWithAttachments } from "./delete-email";

/**
 * Hard-delete every email + person whose address matches any block rule, and
 * clean up R2 attachments. Matches exact-email rules and domain rules (via the
 * computed domain of people.email). Returns counts for the caller/UI.
 */
export async function purgeBlockedMail(
  db: DrizzleD1Database<any>,
  r2: R2Bucket,
): Promise<{ emailsDeleted: number; peopleDeleted: number }> {
  // People whose address is blocked (exact email OR domain match).
  const blockedPeople = await db.all<{ id: string }>(sql`
    SELECT p.id FROM people p
    WHERE EXISTS (
      SELECT 1 FROM blocklist b
      WHERE (b.type = 'email'  AND b.value = p.email)
         OR (b.type = 'domain' AND b.value = lower(substr(p.email, instr(p.email, '@') + 1)))
    )
  `);

  let emailsDeleted = 0;
  for (const { id: personId } of blockedPeople) {
    // Received emails (with R2 attachment cleanup).
    const received = await db
      .select({ id: emails.id })
      .from(emails)
      .where(eq(emails.personId, personId));
    for (const e of received) {
      const res = await deleteEmailWithAttachments(db, r2, e.id);
      if (res) emailsDeleted++;
    }
    // Any sent emails attributed to this person.
    await db.delete(sentEmails).where(eq(sentEmails.personId, personId));
    // Finally the person row.
    await db.delete(people).where(eq(people.id, personId));
  }

  return { emailsDeleted, peopleDeleted: blockedPeople.length };
}
