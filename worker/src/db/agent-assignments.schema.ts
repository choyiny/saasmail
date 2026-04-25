import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// mode values:
//   "first_thread_reply" — send only when this is the first email in the thread
//   "every_mail_reply"   — send on every inbound email from this person
//   "draft_only"         — create a draft instead of sending

export const agentAssignments = sqliteTable(
  "agent_assignments",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    // Scope — both nullable means "wildcard" (match any mailbox / any person).
    mailbox: text("mailbox"),
    personId: text("person_id"),
    templateSlug: text("template_slug").notNull(),
    mode: text("mode").notNull(),
    isActive: integer("is_active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("assignments_agent_idx").on(table.agentId),
    index("assignments_mailbox_person_idx").on(table.mailbox, table.personId),
  ],
);
