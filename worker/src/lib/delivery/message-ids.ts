import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { deliveryMessageIds } from "../../db/delivery-events.schema";
import { bracketedMessageId } from "../message-id";
import type { SendOutput } from "../send";

/**
 * Keep the provider Message-ID of every further copy of a sent message, so a
 * delivery event about a Cc copy finds its message (docs/suppressions.md).
 * Best effort: the mail has gone out, and a lost mapping only leaves that
 * copy's event uncorrelated.
 */
export async function recordCopyMessageIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: DrizzleD1Database<any>,
  sentEmailId: string,
  send: Pick<SendOutput, "copies">,
): Promise<void> {
  const ids = [
    ...new Set(
      (send.copies ?? [])
        .filter((copy) => !copy.error && copy.deliveredMessageId?.trim())
        .map((copy) => bracketedMessageId(copy.deliveredMessageId!)),
    ),
  ];
  if (ids.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    // One JSON parameter, not three per copy: D1 binds at most 100 values
    // per statement, and a send may have up to 49 Cc copies.
    await db
      .insert(deliveryMessageIds)
      .select(
        sql`SELECT value, ${sentEmailId}, ${now} FROM json_each(${JSON.stringify(ids)}) WHERE true`,
      )
      .onConflictDoNothing();
  } catch (error) {
    console.error(
      `[delivery] copy Message-IDs of ${sentEmailId} not kept:`,
      error,
    );
  }
}
