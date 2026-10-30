import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { rules } from "./rules.schema";

export const autoReplyLog = sqliteTable(
  "auto_reply_log",
  {
    ruleId: text("rule_id")
      .notNull()
      .references(() => rules.id, { onDelete: "cascade" }),
    sender: text("sender").notNull(),
    sentAt: integer("sent_at").notNull(),
  },
  (table) => [
    uniqueIndex("auto_reply_log_rule_sender_unique").on(
      table.ruleId,
      table.sender,
    ),
  ],
);
