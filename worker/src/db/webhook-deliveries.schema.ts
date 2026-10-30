import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * The delivery log of the outbound webhook events (docs/webhooks.md): one row
 * per event, retried through `EMAIL_QUEUE`. `message.received` keeps its
 * single inline attempt and writes no row. Finished rows are pruned after 7
 * days.
 */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    /** The deliveryId sent in the `X-SaaSMail-Delivery` header and the body. */
    id: text("id").primaryKey(),
    /** `sent:<sent_emails.id>:<event>` or `delivery:<delivery_events.id>`. */
    sourceKey: text("source_key").notNull(),
    event: text("event").notNull(),
    /** `sent_emails.id`. No address and no subject outside the payload. */
    messageId: text("message_id").notNull(),
    /** The config generation it was recorded under. */
    generation: integer("generation").notNull(),
    /** The JSON body while pending; null once finished. */
    payload: text("payload"),
    /** 1 once the payload is final (before the first POST). */
    frozen: integer("frozen").notNull().default(0),
    /** pending | delivered | failed | cancelled */
    status: text("status").notNull(),
    /** Attempts claimed so far: counted when an attempt starts. */
    attempts: integer("attempts").notNull().default(0),
    /**
     * Unix seconds until which one consumer holds the current attempt. A
     * finished row keeps the negative marker of the call that finished it.
     */
    claimedUntil: integer("claimed_until"),
    /** HTTP status of the last attempt. */
    lastStatus: integer("last_status"),
    /** Network error of the last attempt, at most 200 characters. */
    lastError: text("last_error"),
    /** Unix seconds. */
    nextAttemptAt: integer("next_attempt_at").notNull(),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_source_key_unique").on(table.sourceKey),
    index("webhook_deliveries_created_idx").on(table.createdAt),
    index("webhook_deliveries_generation_status_finished_idx").on(
      table.generation,
      table.status,
      table.finishedAt,
    ),
    index("webhook_deliveries_status_next_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
