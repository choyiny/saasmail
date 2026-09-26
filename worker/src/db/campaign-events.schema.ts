import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Open and click events, de-duplicated by two **partial** unique indexes that
 * Drizzle's DSL cannot express — they live in a `--custom` migration.
 *
 * A single composite unique index does not work: opens have a NULL
 * `campaign_link_id`, and SQLite permits unlimited rows when a unique-index
 * column is NULL, so every re-open would insert again. One partial index per
 * event type, each over the columns that are non-null for that type, is what
 * actually enforces dedup:
 *
 *   CREATE UNIQUE INDEX campaign_events_open_unique
 *     ON campaign_events (campaign_id, contact_id) WHERE event_type = 'open';
 *   CREATE UNIQUE INDEX campaign_events_click_unique
 *     ON campaign_events (campaign_id, contact_id, campaign_link_id)
 *     WHERE event_type = 'click';
 *
 * A consequence worth stating: at most one click row can exist per contact per
 * link, so "clicks" and "unique clickers" are the same number by construction.
 * There is one click metric, not two.
 */
export const campaignEvents = sqliteTable(
  "campaign_events",
  {
    id: text("id").primaryKey(),
    /** FK campaigns.id */
    campaignId: text("campaign_id").notNull(),
    /** FK contacts.id */
    contactId: text("contact_id").notNull(),
    email: text("email").notNull(),
    eventType: text("event_type", { enum: ["open", "click"] }).notNull(),
    /** FK campaign_links.id — null for opens. */
    campaignLinkId: text("campaign_link_id"),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => [
    index("campaign_events_campaign_type_idx").on(
      table.campaignId,
      table.eventType,
    ),
    // The 24-hour timeseries buckets by campaign and time.
    index("campaign_events_campaign_occurred_idx").on(
      table.campaignId,
      table.occurredAt,
    ),
  ],
);

export type CampaignEvent = typeof campaignEvents.$inferSelect;
export type NewCampaignEvent = typeof campaignEvents.$inferInsert;
