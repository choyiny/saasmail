import { and, desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../../db/emails.schema";
import { inboxFilter, type AllowedInboxes } from "../inbox-permissions";

export async function latestAllowedInboxForPerson(
  db: DrizzleD1Database<any>,
  personId: string,
  allowed: AllowedInboxes,
): Promise<string> {
  const permissionScope = inboxFilter(allowed, emails.recipient);
  const rows = await db
    .select({ recipient: emails.recipient })
    .from(emails)
    .where(
      permissionScope
        ? and(eq(emails.personId, personId), permissionScope)
        : eq(emails.personId, personId),
    )
    .orderBy(desc(emails.receivedAt))
    .limit(1);

  const inbox = rows[0]?.recipient;
  if (!inbox) {
    throw new Error("No permitted inbox is available for this person");
  }
  return inbox;
}
