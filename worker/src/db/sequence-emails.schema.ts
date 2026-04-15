import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const sequenceEmails = sqliteTable(
  "sequence_emails",
  {
    id: text("id").primaryKey(),
    enrollmentId: text("enrollment_id").notNull(),
    stepOrder: integer("step_order").notNull(),
    templateSlug: text("template_slug").notNull(),
    scheduledAt: integer("scheduled_at").notNull(),
    status: text("status").notNull().default("pending"), // pending, queued, sent, cancelled, failed
    sentAt: integer("sent_at"),
    sentEmailId: text("sent_email_id"),
  },
  (table) => [
    index("seq_emails_status_scheduled_idx").on(
      table.status,
      table.scheduledAt,
    ),
  ],
);
