import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users } from "../db/auth.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";

export type AssigneeRow = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export async function listAssigneesForInbox(
  db: DrizzleD1Database<any>,
  inbox: string,
): Promise<AssigneeRow[]> {
  const canonicalInbox = inbox.trim().toLowerCase();
  return db.all<AssigneeRow>(sql`
    SELECT DISTINCT
      u.id AS id,
      u.name AS name,
      u.email AS email,
      u.image AS image
    FROM ${users} AS u
    LEFT JOIN ${inboxPermissions} AS ip
      ON ip.user_id = u.id
      AND lower(ip.email) = ${canonicalInbox}
    WHERE u.role = 'admin' OR ip.user_id IS NOT NULL
    ORDER BY u.name, u.email, u.id
  `);
}
