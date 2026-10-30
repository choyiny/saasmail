import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

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
  spamThreshold: real("spam_threshold"),
  agentInstructions: text("agent_instructions"),
  agentAutodraft: integer("agent_autodraft").notNull().default(0),
  /**
   * How the inbox groups conversations: `relationship` (one per customer,
   * the default) or `headers` (threads by In-Reply-To/References, like a mail
   * client). See docs/inboxes.md.
   */
  threadingMode: text("threading_mode", { enum: ["relationship", "headers"] })
    .notNull()
    .default("relationship"),
  /**
   * Where this inbox's mail comes from. "cloudflare" = Email Routing delivers
   * to the Worker; "gmail" = a connected Google mailbox is polled for it;
   * "outlook" = a connected Microsoft mailbox is.
   * Existing rows default to "cloudflare", which is what they have always been.
   */
  source: text("source", { enum: ["cloudflare", "gmail", "outlook"] })
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
  /** FK to outlook_accounts.id. Null unless source = "outlook". */
  outlookAccountId: text("outlook_account_id"),
  /**
   * `test`: a test inbox. Its mail skips rules, spam, notifications, webhooks
   * and forwarding, `local+detail@` maps to it, and it is deleted after
   * `testRetentionDays`. See docs/inboxes.md.
   */
  purpose: text("purpose", { enum: ["mail", "test"] })
    .notNull()
    .default("mail"),
  /** Days a test inbox keeps its mail (1–30). Null = 3. */
  testRetentionDays: integer("test_retention_days"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
