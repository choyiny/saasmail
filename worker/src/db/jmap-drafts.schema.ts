import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";
import { jmapMessageContent } from "./jmap-message-content.schema";

/** A JMAP draft Email: a content row plus its mutable state (spec §4). */
export const jmapDrafts = sqliteTable(
  "jmap_drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contentId: text("content_id")
      .notNull()
      .references(() => jmapMessageContent.id),
    /** Lowercased identity address; drafts are visible only while it's allowed. */
    inbox: text("inbox").notNull(),
    receivedAt: integer("received_at").notNull(),
    mailboxRole: text("mailbox_role", { enum: ["drafts", "trash"] })
      .notNull()
      .default("drafts"),
    seen: integer("seen").notNull().default(0),
    flagged: integer("flagged").notNull().default(0),
    /**
     * JSON array of the custom `mailboxes.id` the draft is filed in, beside its
     * system mailbox (`mailbox_role`). Personal like the draft; a deleted folder
     * is removed by a trigger on `mailboxes`.
     */
    folderIds: text("folder_ids").notNull().default("[]"),
    /** null | "submitting" (claimed by a submission) | "queued" (outbox retrying). */
    submitState: text("submit_state", { enum: ["submitting", "queued"] }),
    /** Internal id of the submission holding the lock. */
    submitAttemptId: text("submit_attempt_id"),
    /**
     * Set to 1 immediately before the alias deletes this row, so the delete
     * trigger writes no 'd': the same Email id lives on as a Sent Email.
     */
    aliasDelete: integer("alias_delete").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("jmap_drafts_user_received_idx").on(table.userId, table.receivedAt),
    index("jmap_drafts_content_idx").on(table.contentId),
  ],
);
