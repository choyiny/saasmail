import { eq, inArray, isNull, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emailTemplates } from "../../db/email-templates.schema";
import { isInboxAllowed, type AllowedInboxes } from "../inbox-permissions";

export type TemplateRow = typeof emailTemplates.$inferSelect;

/**
 * List email templates visible to the caller. A template with a null
 * `fromAddress` is global (visible to everyone); one bound to an inbox is only
 * visible to callers allowed on that inbox. Admins see all.
 *
 * Shared by the HTTP list route and the MCP `list_templates` tool so both
 * enforce the same visibility rule.
 */
export async function listTemplates(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
): Promise<TemplateRow[]> {
  if (allowed.isAdmin) {
    return db.select().from(emailTemplates);
  }
  if (allowed.inboxes.length === 0) {
    return db
      .select()
      .from(emailTemplates)
      .where(isNull(emailTemplates.fromAddress));
  }
  return db
    .select()
    .from(emailTemplates)
    .where(
      or(
        isNull(emailTemplates.fromAddress),
        inArray(emailTemplates.fromAddress, allowed.inboxes),
      ),
    );
}

/**
 * Fetch a template by slug, or null when it does not exist OR the caller may
 * not see it (a template bound to an inbox they are not allowed on). Collapsing
 * both cases to null keeps callers from probing which slugs exist behind
 * inboxes they cannot access.
 */
export async function getTemplateBySlug(
  db: DrizzleD1Database<any>,
  slug: string,
  allowed: AllowedInboxes,
): Promise<TemplateRow | null> {
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);
  if (rows.length === 0) {
    return null;
  }
  const template = rows[0];
  if (
    !allowed.isAdmin &&
    template.fromAddress !== null &&
    !isInboxAllowed(allowed, template.fromAddress)
  ) {
    return null;
  }
  return template;
}
