import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * Immutable RFC 8621 representation of a JMAP-originated message (spec §4).
 * Shared by a draft and by every Sent Email created from it. Deleted only by
 * reference-counting GC (collectUnreferencedContent) — never by cascade, so
 * deleting the author's account can't remove content a shared Sent row still
 * shows (spec §10.2).
 */
export const jmapMessageContent = sqliteTable(
  "jmap_message_content",
  {
    id: text("id").primaryKey(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Lowercased identity address the message is sent from. */
    inbox: text("inbox").notNull(),
    fromJson: text("from_json").notNull(),
    toJson: text("to_json").notNull(),
    ccJson: text("cc_json").notNull(),
    bccJson: text("bcc_json").notNull(),
    replyToJson: text("reply_to_json"),
    subject: text("subject").notNull(),
    /** Without angle brackets. */
    messageId: text("message_id").notNull(),
    inReplyToJson: text("in_reply_to_json"),
    referencesJson: text("references_json"),
    /** RFC 3339 string as given by the client, or server-set `…Z`. */
    sentAt: text("sent_at").notNull(),
    partsJson: text("parts_json").notNull(),
    textBodyJson: text("text_body_json").notNull(),
    htmlBodyJson: text("html_body_json").notNull(),
    attachmentsJson: text("attachments_json").notNull(),
    bodyValuesJson: text("body_values_json").notNull(),
    preview: text("preview").notNull(),
    /** Internal thread key (see draftThreadKey). */
    threadKey: text("thread_key").notNull(),
    rawR2Key: text("raw_r2_key").notNull(),
    /** Octets of the raw message. */
    size: integer("size").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("jmap_message_content_thread_key_idx").on(table.threadKey),
    index("jmap_message_content_created_at_idx").on(table.createdAt),
  ],
);
