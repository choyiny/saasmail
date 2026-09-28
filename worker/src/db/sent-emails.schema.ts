import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sentEmails = sqliteTable(
  "sent_emails",
  {
    id: text("id").primaryKey(),
    personId: text("person_id"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    inReplyTo: text("in_reply_to"),
    messageId: text("message_id"),
    resendId: text("resend_id"),
    status: text("status").notNull().default("sent"),
    /**
     * JSON-encoded array of {"email","name"} objects for outbound CC
     * recipients. NULL = no CC. Mirrors the `cc` column on `emails`.
     */
    cc: text("cc"),
    /**
     * JSON [{email,name}]: To recipients after `to_address`, and blind
     * recipients. Only JMAP submissions set them. NULL = none.
     */
    additionalTo: text("additional_to"),
    bcc: text("bcc"),
    /**
     * Group-thread identity. Mirrors `emails.conversation_id`. See
     * migration 0022 for the algorithm + rationale.
     */
    conversationId: text("conversation_id"),
    /**
     * FK campaigns.id — null for every non-campaign send. Lets a campaign send
     * appear in the recipient's timeline without any new query logic.
     */
    campaignId: text("campaign_id"),
    sequenceId: text("sequence_id"),
    sequenceEnrollmentId: text("sequence_enrollment_id"),
    /**
     * `jmap_message_content.id` for mail sent through JMAP EmailSubmission.
     * JMAP projects the Email's immutable properties from that content row.
     */
    jmapContentId: text("jmap_content_id"),
    /**
     * Internal id of the JMAP draft this Sent row became when a submission's
     * on-success step filed the draft into Sent (the alias). JMAP shows the
     * row as `D<jmapEmailId>`, never as `S<id>`. Null for every other row.
     */
    jmapEmailId: text("jmap_email_id"),
    /**
     * The JMAP Email's receivedAt, which RFC 8621 keeps immutable: the aliased
     * draft's, or for a delayed send the time it was scheduled (`sent_at` then
     * moves to the real send time).
     */
    jmapReceivedAt: integer("jmap_received_at"),
    /**
     * Set to 1 immediately before the reverse alias deletes this row (a canceled
     * delayed send moved back to Drafts), so its triggers write no change rows:
     * the same Email id lives on as a draft.
     */
    aliasRestore: integer("alias_restore").notNull().default(0),
    sentAt: integer("sent_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("sent_emails_person_sent_idx").on(table.personId, table.sentAt),
    index("sent_emails_conversation_idx").on(table.conversationId),
    index("sent_emails_from_sent_idx").on(table.fromAddress, table.sentAt),
    index("sent_emails_sequence_sent_idx").on(table.sequenceId, table.sentAt),
    index("sent_emails_jmap_content_idx").on(table.jmapContentId),
    // JMAP thread lookup and reply-chain mapping find a sent message by the
    // Message-ID it was delivered with.
    index("sent_emails_message_id_idx").on(table.messageId),
    uniqueIndex("sent_emails_jmap_email_id_unique").on(table.jmapEmailId),
  ],
);
