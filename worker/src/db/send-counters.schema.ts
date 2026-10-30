import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Messages each user sent today, per channel, for the daily send caps
 * (worker/src/lib/sending-controls.ts). Rows older than 7 days are pruned.
 */
export const sendCounters = sqliteTable(
  "send_counters",
  {
    userId: text("user_id").notNull(),
    /** web | api | mcp | jmap */
    channel: text("channel").notNull(),
    /** The UTC date, YYYY-MM-DD. */
    day: text("day").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.channel, table.day] }),
  ],
);
