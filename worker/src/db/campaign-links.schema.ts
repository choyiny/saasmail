import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Destination URLs for click tracking, referenced by opaque id.
 *
 * A click token carries this row's id and never the URL itself. HMAC protects
 * integrity, not confidentiality, so a URL inside a token would be readable by
 * anyone who sees the link — and campaign links can themselves carry signed or
 * passwordless query parameters, which then leak through proxy logs, browser
 * history and forwarded mail.
 */
export const campaignLinks = sqliteTable(
  "campaign_links",
  {
    id: text("id").primaryKey(),
    /** FK campaigns.id */
    campaignId: text("campaign_id").notNull(),
    /** Validated http(s) only at write time, before it is ever redirected to. */
    url: text("url").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    // The same URL reused by many recipients maps to one row.
    uniqueIndex("campaign_links_campaign_url_unique").on(
      table.campaignId,
      table.url,
    ),
  ],
);

export type CampaignLink = typeof campaignLinks.$inferSelect;
export type NewCampaignLink = typeof campaignLinks.$inferInsert;
