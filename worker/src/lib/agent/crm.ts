import { desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../../db/emails.schema";
import { isInboxAllowed, type AllowedInboxes } from "../inbox-permissions";

export async function latestAllowedInboxForPerson(
  db: DrizzleD1Database<any>,
  personId: string,
  allowed: AllowedInboxes,
): Promise<string> {
  const rows = await db
    .select({ recipient: emails.recipient })
    .from(emails)
    .where(eq(emails.personId, personId))
    .orderBy(desc(emails.receivedAt));

  const inbox = rows.find((row) =>
    isInboxAllowed(allowed, row.recipient),
  )?.recipient;
  if (!inbox) {
    throw new Error("No permitted inbox is available for this person");
  }
  return inbox;
}
