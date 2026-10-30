import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * What a provider reported after it accepted a message: a bounce, a spam
 * complaint, a rejection or a failure (docs/suppressions.md). Never written to
 * `sent_emails`: an UPDATE there writes a JMAP change row, so reads attach
 * these rows to the message instead.
 */
export const deliveryEvents = sqliteTable(
  "delivery_events",
  {
    /** `<provider>:<provider event id>`: a redelivered event conflicts away. */
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    kind: text("kind", {
      enum: ["bounced", "complained", "failed", "rejected"],
    }).notNull(),
    bounceType: text("bounce_type", { enum: ["hard", "soft"] }),
    sentEmailId: text("sent_email_id"),
    campaignId: text("campaign_id"),
    /** Bracketed, as `sent_emails.message_id`. */
    messageId: text("message_id"),
    /** Lowercased and trimmed. */
    recipient: text("recipient").notNull(),
    sender: text("sender"),
    smtpStatus: text("smtp_status"),
    detail: text("detail"),
    occurredAt: integer("occurred_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("delivery_events_recipient_idx").on(
      table.recipient,
      table.occurredAt,
    ),
    index("delivery_events_sent_email_idx").on(table.sentEmailId),
    index("delivery_events_campaign_kind_idx").on(table.campaignId, table.kind),
  ],
);

export type DeliveryEventRow = typeof deliveryEvents.$inferSelect;

/**
 * The provider Message-ID of each further copy of a sent message: a
 * non-transactional send goes to each recipient separately, and its
 * `sent_emails` row keeps only the first copy's id. Delivery events about the
 * other copies correlate through this table.
 */
export const deliveryMessageIds = sqliteTable(
  "delivery_message_ids",
  {
    /** Bracketed, as `sent_emails.message_id`. */
    messageId: text("message_id").primaryKey(),
    sentEmailId: text("sent_email_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("delivery_message_ids_sent_email_idx").on(table.sentEmailId),
  ],
);
