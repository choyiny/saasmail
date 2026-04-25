import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// status: queued | running | succeeded | failed |
//         skipped_inactive | skipped_mode | skipped_loop | skipped_rate_limit
// action: "sent" | "draft" | null

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id").notNull(),
    emailId: text("email_id").notNull(),
    personId: text("person_id").notNull(),
    status: text("status").notNull(),
    action: text("action"),
    sentEmailId: text("sent_email_id"),
    draftId: text("draft_id"),
    modelId: text("model_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("runs_assignment_person_created_idx").on(
      table.assignmentId,
      table.personId,
      table.createdAt,
    ),
    index("runs_email_idx").on(table.emailId),
    index("runs_status_created_idx").on(table.status, table.createdAt),
  ],
);
