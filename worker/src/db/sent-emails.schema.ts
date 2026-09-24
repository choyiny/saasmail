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
     * Group-thread identity. Mirrors `emails.conversation_id`. See
     * migration 0022 for the algorithm + rationale.
     */
    conversationId: text("conversation_id"),
    /**
     * Gmail's id for the message it created when we sent this. Null for
     * Cloudflare-sent mail. This is the echo-suppression key: a later
     * slice mirrors `SENT` messages from Gmail onto the timeline, and
     * without this id every reply we send through Gmail would come back
     * through that mirror and appear twice.
     *
     * Unique per mailbox — see `sent_emails_gmail_message_from_unique`
     * below.
     */
    gmailMessageId: text("gmail_message_id"),
    /**
     * Gmail's thread id for this message. Setting it on send is what
     * makes a reply thread inside Gmail instead of starting a new
     * conversation. It repeats by design: every message in a thread
     * shares the same id, so it is NOT unique here.
     */
    gmailThreadId: text("gmail_thread_id"),
    sentAt: integer("sent_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("sent_emails_person_sent_idx").on(table.personId, table.sentAt),
    index("sent_emails_conversation_idx").on(table.conversationId),
    index("sent_emails_from_sent_idx").on(table.fromAddress, table.sentAt),
    /**
     * Echo suppression looks this pair up once per mirrored Gmail `SENT`
     * message (see `lib/gmail/sync.ts`), against a table that grows without
     * bound — so the lookup needs an index or it degrades into a full scan
     * per message.
     *
     * UNIQUE, because the lookup alone cannot hold the invariant. It is a
     * SELECT that the send path's own insert races: Gmail files a message in
     * the Sent folder the instant it returns its 2xx, so a cron tick landing
     * between that 2xx and the row being written finds nothing and mirrors
     * saasmail's own reply as if a human had typed it in Gmail. Two
     * overlapping ticks do the same to any mirrored message — nothing leases
     * the cron. Either way the result is two rows for one reply, permanently:
     * nothing reconciles them, and every later replay now DOES find a row, so
     * the duplicate is stable.
     *
     * Scoped by `from_address` because Gmail documents message ids as unique
     * per MAILBOX, not globally, so a global constraint would let one
     * mailbox's id refuse another's genuine Sent message. Both writers are
     * conflict-aware: the mirror inserts `onConflictDoNothing` and treats a
     * refused insert as a skip, and the send path — whose row is the
     * authoritative one — clears any mirrored row for the same pair in the
     * same D1 batch as its own insert.
     *
     * NULLs are distinct in a SQLite unique index, so Cloudflare-sent rows
     * (which leave this column null) are not constrained by it at all.
     */
    uniqueIndex("sent_emails_gmail_message_from_unique").on(
      table.gmailMessageId,
      table.fromAddress,
    ),
  ],
);
