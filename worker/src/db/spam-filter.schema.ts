import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * One learning spam filter per inbox (worker/src/lib/spam): whether it scores
 * new mail, and how many messages it was trained on.
 */
export const spamModels = sqliteTable("spam_models", {
  inbox: text("inbox").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  spamMessages: integer("spam_messages").notNull().default(0),
  hamMessages: integer("ham_messages").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

/** How often each token appeared in an inbox's junk and not-junk mail. */
export const spamTokens = sqliteTable(
  "spam_tokens",
  {
    inbox: text("inbox").notNull(),
    token: text("token").notNull(),
    spamCount: integer("spam_count").notNull().default(0),
    hamCount: integer("ham_count").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.inbox, table.token] })],
);

/**
 * The label each message was trained with, so a message counts once per
 * label and a change of mind retrains it. Deleted with the message
 * (`deleteMessageState`).
 */
export const spamTraining = sqliteTable(
  "spam_training",
  {
    inbox: text("inbox").notNull(),
    emailId: text("email_id").notNull(),
    /** spam | ham */
    label: text("label").notNull(),
    trainedBy: text("trained_by"),
    trainedAt: integer("trained_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.inbox, table.emailId] }),
    // Deleting a message finds its row by id alone.
    index("spam_training_email_idx").on(table.emailId),
  ],
);
