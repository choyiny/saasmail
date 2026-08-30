import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sequences } from "../../db/sequences.schema";

type SequenceRow = typeof sequences.$inferSelect;

/** A sequence with its `steps` JSON column parsed into an array. */
export type SequenceWithSteps = Omit<SequenceRow, "steps"> & { steps: unknown };

function parseSteps(row: SequenceRow): SequenceWithSteps {
  return { ...row, steps: JSON.parse(row.steps) };
}

/**
 * List every sequence, oldest first, with steps parsed. Sequences are global
 * (not inbox-scoped) — the same set the HTTP list route returns. Shared so the
 * MCP `list_sequences` tool stays in lockstep with the route.
 */
export async function listSequences(
  db: DrizzleD1Database<any>,
): Promise<SequenceWithSteps[]> {
  const rows = await db.select().from(sequences).orderBy(sequences.createdAt);
  return rows.map(parseSteps);
}

/** Fetch a sequence by id with steps parsed, or null when it does not exist. */
export async function getSequenceById(
  db: DrizzleD1Database<any>,
  id: string,
): Promise<SequenceWithSteps | null> {
  const rows = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, id))
    .limit(1);
  return rows.length === 0 ? null : parseSteps(rows[0]);
}
