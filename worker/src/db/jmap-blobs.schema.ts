import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * JMAP uploads (RFC 8620 §6.1). An upload is readable only by its uploader
 * and lives for 24 hours: drafts copy the bytes they need (PR 4), so the
 * hourly reaper deletes by age alone. R2 key: jmap-uploads/<userId>/<id>.
 *
 * `user_id` deliberately has no foreign key. A cascade on user deletion would
 * drop the row and leave its R2 object untracked; without one, the reaper
 * removes the object and then the row within 24 hours.
 */
export const jmapBlobs = sqliteTable(
  "jmap_blobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    type: text("type").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("jmap_blobs_user_idx").on(table.userId),
    index("jmap_blobs_created_at_idx").on(table.createdAt),
  ],
);
