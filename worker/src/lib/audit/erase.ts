import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { auditEvents } from "../../db/audit-events.schema";
import { AUDIT_ACTIONS } from "./events";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces every whole occurrence of `email` in `text`, ignoring case. A longer
 * address that contains it ("jim" + "bob@x.com", or "bob@x.com" + ".au") is a
 * different person and is left alone.
 */
export function replaceAddress(
  text: string,
  email: string,
  replacement: string,
): string {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9._%+'-])${escapeRegExp(email)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`,
    "gi",
  );
  return text.replace(pattern, () => replacement);
}

function replaceInJson(value: unknown, email: string, token: string): unknown {
  if (typeof value === "string") return replaceAddress(value, email, token);
  if (Array.isArray(value)) {
    return value.map((item) => replaceInJson(item, email, token));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceInJson(item, email, token),
      ]),
    );
  }
  return value;
}

/**
 * Rewrites a newsletter subject's address to its erasure pseudonym in the
 * audit events the newsletter features wrote: list members added or removed,
 * and campaign test sends. Mail audit events stay as they are, like the mail
 * they describe; erasure covers the newsletter records only.
 *
 * Returns how many events changed.
 */
export async function eraseAddressFromNewsletterAudit(
  db: Db,
  email: string,
  token: string,
): Promise<number> {
  const rows = await db
    .select({
      id: auditEvents.id,
      summary: auditEvents.summary,
      details: auditEvents.details,
    })
    .from(auditEvents)
    .where(
      and(
        or(
          and(
            eq(auditEvents.targetType, "list"),
            inArray(auditEvents.action, [
              AUDIT_ACTIONS.listMemberAdded,
              AUDIT_ACTIONS.listMemberRemoved,
            ]),
          ),
          and(
            eq(auditEvents.targetType, "campaign"),
            eq(auditEvents.action, AUDIT_ACTIONS.mailSent),
          ),
        ),
        or(
          sql`instr(lower(${auditEvents.summary}), ${email}) > 0`,
          sql`instr(lower(coalesce(${auditEvents.details}, '')), ${email}) > 0`,
        ),
      ),
    );

  let changed = 0;
  for (const row of rows) {
    const summary = replaceAddress(row.summary, email, token);
    let details = row.details;
    if (details !== null) {
      try {
        details = JSON.stringify(
          replaceInJson(JSON.parse(details), email, token),
        );
      } catch {
        details = replaceAddress(details, email, token);
      }
    }
    if (summary === row.summary && details === row.details) continue;
    await db
      .update(auditEvents)
      .set({ summary, details })
      .where(eq(auditEvents.id, row.id));
    changed++;
  }
  return changed;
}
