import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Who did what, append-only. Written best-effort by `recordAudit`
 * (worker/src/lib/audit/record.ts) and pruned after the retention period.
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    /** Unix seconds. */
    at: integer("at").notNull(),
    /** user | api_key | mcp | jmap | agent | rule | system */
    actorType: text("actor_type").notNull(),
    /** The person behind the actor, also for an API key, MCP, JMAP or the agent. */
    actorUserId: text("actor_user_id"),
    /** "jane@acme.com", "API key sk_1234…", "rule Invoices", "system". */
    actorLabel: text("actor_label").notNull(),
    /** web | api | mcp | jmap | agent | rule | inbound | cron | queue | import */
    channel: text("channel").notNull(),
    /** A dotted name from worker/src/lib/audit/events.ts. */
    action: text("action").notNull(),
    targetType: text("target_type"),
    /** NULL for a bulk operation: `details` then has the count and first refs. */
    targetId: text("target_id"),
    /** Lowercase inbox address, when the event belongs to one. */
    inbox: text("inbox"),
    /** One sentence written by the emitter, at most 300 characters. */
    summary: text("summary").notNull(),
    /** JSON, at most 4 KB. Never holds a secret. */
    details: text("details"),
    /** cf-connecting-ip; HTTP channels only. */
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("audit_events_at_idx").on(table.at),
    index("audit_events_actor_at_idx").on(table.actorUserId, table.at),
    index("audit_events_inbox_at_idx").on(table.inbox, table.at),
    index("audit_events_action_at_idx").on(table.action, table.at),
  ],
);
