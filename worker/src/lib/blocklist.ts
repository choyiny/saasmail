import { and, eq, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { schema } from "../db/schema";
import { blocklist } from "../db/blocklist.schema";

export type Database = DrizzleD1Database<typeof schema>;

/** Lowercased domain part of an email address (everything after the last "@"). */
export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/** True if the sender email (exact) or its domain is on the blocklist. */
export async function isBlocked(db: Database, email: string): Promise<boolean> {
  const addr = email.trim().toLowerCase();
  const domain = domainOf(addr);
  const row = await db.query.blocklist.findFirst({
    where: or(
      and(eq(blocklist.type, "email"), eq(blocklist.value, addr)),
      and(eq(blocklist.type, "domain"), eq(blocklist.value, domain)),
    ),
    columns: { id: true },
  });
  return !!row;
}
