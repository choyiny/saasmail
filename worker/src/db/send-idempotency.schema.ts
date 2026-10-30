import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Idempotency keys of the send routes and tools: a send retried with the same
 * key returns the first answer instead of sending again. Kept 24 hours
 * (worker/src/lib/send-idempotency.ts).
 */
export const sendIdempotency = sqliteTable(
  "send_idempotency",
  {
    /** Keys belong to the person behind the request (session, API key, MCP). */
    userId: text("user_id").notNull(),
    /** 1–255 printable ASCII characters, chosen by the client. */
    key: text("key").notNull(),
    /** SHA-256 hex of the canonical request, to tell a retry from a reuse. */
    fingerprint: text("fingerprint").notNull(),
    /** pending | completed */
    status: text("status").notNull(),
    responseStatus: integer("response_status"),
    /** The exact JSON body returned, replayed to a retry. */
    responseBody: text("response_body"),
    sentEmailId: text("sent_email_id"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.key] }),
    index("send_idempotency_created_at_idx").on(table.createdAt),
  ],
);
