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

export function assertInboxAllowed(
  allowed: AllowedInboxes,
  email: string,
): void {
  if (allowed.isAdmin) return;
  // Compare lowercased so a member who registered `Support@x.com` in
  // permissions still passes when the route asserts `support@x.com`
  // (callers now canonicalize inputs at the boundary, but be
  // defensive in case future callers don't).
  if (!allowed.inboxes.includes(email.toLowerCase())) {
    throw new HTTPException(403, { message: "Inbox not allowed" });
  }
}
