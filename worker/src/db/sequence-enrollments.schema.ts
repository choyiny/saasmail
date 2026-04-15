import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const sequenceEnrollments = sqliteTable(
  "sequence_enrollments",
  {
    id: text("id").primaryKey(),
    sequenceId: text("sequence_id").notNull(),
    senderId: text("sender_id").notNull(),
    status: text("status").notNull().default("active"), // active, completed, cancelled
    variables: text("variables").notNull().default("{}"), // JSON
    enrolledAt: integer("enrolled_at").notNull(),
    cancelledAt: integer("cancelled_at"),
  },
  (table) => [
    index("enrollments_sender_status_idx").on(table.senderId, table.status),
  ],
);
