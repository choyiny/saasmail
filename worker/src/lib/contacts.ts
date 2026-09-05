import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { contacts } from "../db/contacts.schema";

/**
 * Strip characters that must never reach a rendered template or a mail header.
 *
 * `contacts.name` is the first template-variable source in this codebase fed by
 * unauthenticated bulk input (the public subscribe form and CSV import), rather
 * than by an authenticated API caller. CR/LF in a personalization value is a
 * header-injection vector, and other C0 controls corrupt rendered output.
 *
 * HTML escaping is *not* done here — `lib/interpolate.ts` already escapes by
 * default at render time, and double-escaping at ingestion would store
 * `&amp;lt;` in the database.
 */
export function sanitizeContactName(
  name: string | null | undefined,
): string | null {
  if (name == null) return null;
  // C0 controls plus DEL, written as escapes so the source stays printable.
  // Replaced with a space rather than removed, so "Alice\nBob" reads as
  // "Alice Bob" rather than the misleading "AliceBob".
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * Find or create the `contacts` row for an address.
 *
 * Unlike the `people` lookup in `lib/find-person.ts`, creating *is* correct
 * here — `contacts` is the subscriber identity table and this is where
 * subscribers are supposed to land. The race is handled the same way the
 * existing `people` create does it: conflict-ignore on the unique column, then
 * re-select, so two concurrent form submissions for the same address resolve to
 * one row.
 *
 * An existing contact's `name` is filled in when we learn one and it was
 * previously unknown, but never overwritten — a subscriber who typed their name
 * on a form should not have it clobbered by a later import that omits it.
 */
export async function findOrCreateContact(
  db: DrizzleD1Database<any>,
  email: string,
  name: string | null,
  now: number,
): Promise<{ id: string; email: string }> {
  const normalized = email.trim().toLowerCase();
  const cleanName = sanitizeContactName(name);

  const existing = await db
    .select({ id: contacts.id, name: contacts.name })
    .from(contacts)
    .where(eq(contacts.email, normalized))
    .limit(1);

  if (existing[0]) {
    if (cleanName !== null && existing[0].name === null) {
      await db
        .update(contacts)
        .set({ name: cleanName, updatedAt: now })
        .where(eq(contacts.id, existing[0].id));
    }
    return { id: existing[0].id, email: normalized };
  }

  const id = nanoid();
  await db
    .insert(contacts)
    .values({
      id,
      email: normalized,
      name: cleanName,
      personId: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: contacts.email });

  const refetched = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, normalized))
    .limit(1);

  return { id: refetched[0]!.id, email: normalized };
}
