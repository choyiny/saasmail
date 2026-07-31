import { eq, inArray, sql, SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AnyColumn } from "drizzle-orm";
import { inboxPermissions } from "../db/inbox-permissions.schema";

export type AllowedInboxes =
  | { isAdmin: true }
  | { isAdmin: false; inboxes: string[] };

export async function resolveAllowedInboxes(
  db: DrizzleD1Database<any>,
  user: { id: string; role: string | null },
): Promise<AllowedInboxes> {
  if (user.role === "admin") {
    return { isAdmin: true };
  }
  const rows = await db
    .select({ email: inboxPermissions.email })
    .from(inboxPermissions)
    .where(eq(inboxPermissions.userId, user.id));
  // Lowercase at resolution time so every downstream allow-check is
  // case-insensitive without needing each caller to remember to
  // normalize. Older `inbox_permissions.email` rows may be mixed
  // case from before insert-time canonicalization.
  return {
    isAdmin: false,
    inboxes: rows.map((r) => r.email.toLowerCase()),
  };
}

export function inboxFilter(
  allowed: AllowedInboxes,
  column: AnyColumn,
): SQL | undefined {
  if (allowed.isAdmin) return undefined;
  if (allowed.inboxes.length === 0) return sql`0`;
  return inArray(column, allowed.inboxes);
}

/**
 * The single "may this caller act on this address?" predicate.
 *
 * Normalization lives here and nowhere else. `allowed.inboxes` is lowercased at
 * resolution time, but stored `recipient` / `from_address` values may be mixed
 * case from before insert-time canonicalization, so the address is folded too.
 *
 * Call this rather than reaching into `allowed.inboxes` directly: hand-rolled
 * `allowed.inboxes.includes(x)` copies previously drifted apart, leaving a row
 * a member could delete but not read.
 */
export function isInboxAllowed(
  allowed: AllowedInboxes,
  email: string,
): boolean {
  return allowed.isAdmin || allowed.inboxes.includes(email.toLowerCase());
}

export function assertInboxAllowed(
  allowed: AllowedInboxes,
  email: string,
): void {
  if (!isInboxAllowed(allowed, email)) {
    throw new HTTPException(403, { message: "Inbox not allowed" });
  }
}

/**
 * Scope fragment for raw-SQL queries, as a spliceable `AND ...` chunk.
 *
 * `inboxFilter` covers Drizzle query builders; this covers the hand-written
 * `sql` templates. Both must agree, and in particular both must express the
 * empty-grant case as a false predicate — an empty list renders `IN ()`, which
 * SQLite rejects outright, so forgetting that branch fails loudly at best and
 * scopes nothing at worst.
 */
export function inboxScopeSql(allowed: AllowedInboxes, column: SQL): SQL {
  if (allowed.isAdmin) return sql``;
  if (allowed.inboxes.length === 0) return sql`AND 0`;
  return sql`AND ${column} IN ${allowed.inboxes}`;
}
