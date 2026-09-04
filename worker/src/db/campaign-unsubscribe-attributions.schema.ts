import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Which campaign gets credited with a list unsubscribe.
 *
 * Modelled as a uniquely-keyed insert rather than an increment on
 * `campaigns.statsUnsubscribes`. A read-then-increment is racy under the
 * concurrent one-click POST and browser GET that a single unsubscribe usually
 * produces, and it undercounts if the process dies between updating the
 * membership and bumping the counter. An insert with `ON CONFLICT DO NOTHING`
 * is safe to repeat, so the whole handler becomes replay-safe.
 *
 * `statsUnsubscribes` is derived from `COUNT(*)` here, never written directly.
 */
export const campaignUnsubscribeAttributions = sqliteTable(
  "campaign_unsubscribe_attributions",
  {
    id: text("id").primaryKey(),
    /** FK campaigns.id */
    campaignId: text("campaign_id").notNull(),
    /** FK list_members.id */
    listMemberId: text("list_member_id").notNull(),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => [
    uniqueIndex("campaign_unsub_attr_campaign_member_unique").on(
      table.campaignId,
      table.listMemberId,
    ),
  ],
);

export type CampaignUnsubscribeAttribution =
  typeof campaignUnsubscribeAttributions.$inferSelect;
