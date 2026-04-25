import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// Agent-generated draft replies (mode = "draft_only").
// Shown in the UI for human review before sending.

export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    personId: text("person_id").notNull(),
    agentRunId: text("agent_run_id").notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html"),
    inReplyTo: text("in_reply_to"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("drafts_person_created_idx").on(table.personId, table.createdAt),
    index("drafts_agent_run_idx").on(table.agentRunId),
  ],
);
