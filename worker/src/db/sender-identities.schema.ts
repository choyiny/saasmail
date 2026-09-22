import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const senderIdentities = sqliteTable("sender_identities", {
  email: text("email").primaryKey(),
  displayName: text("display_name"),
  displayMode: text("display_mode", { enum: ["thread", "chat"] })
    .notNull()
    .default("thread"),
  signatureHtml: text("signature_html"),
  /**
   * Optional destination address. When set, every inbound message to this
   * inbox is re-sent to this address through the configured outbound
   * provider. Null = forwarding off.
   *
   * This exists because Cloudflare Email Routing's own forwarding rules send
   * from a shared IP pool that Outlook/Hotmail blocklists (550 5.7.1 S3150),
   * so forwards to Microsoft-hosted mailboxes silently bounce. Re-sending via
   * Email Sending uses different IPs and DKIM-signs for our own domain.
   */
  forwardTo: text("forward_to"),
  /**
   * Where this inbox's mail comes from. "cloudflare" = Email Routing delivers
   * to the Worker; "gmail" = a connected Google mailbox is polled for it.
   * Existing rows default to "cloudflare", which is what they have always been.
   */
  source: text("source", { enum: ["cloudflare", "gmail"] })
    .notNull()
    .default("cloudflare"),
  /** FK to gmail_accounts.id. Null unless source = "gmail". */
  gmailAccountId: text("gmail_account_id"),
  /**
   * For a Google Group backed by a collector account, the group address to
   * match against Delivered-To / List-ID. Null means "this account's own
   * mailbox" — take everything it receives.
   */
  gmailGroupAddress: text("gmail_group_address"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
