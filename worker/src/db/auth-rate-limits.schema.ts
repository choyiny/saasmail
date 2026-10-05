import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * better-auth's rate-limit counters, one row per client address and auth
 * path (worker/src/auth/rate-limit-storage.ts). Kept in D1 so a limit holds
 * across Worker isolates; expired rows are pruned hourly.
 */
export const authRateLimits = sqliteTable(
  "auth_rate_limits",
  {
    /** better-auth's key: the client address and the auth path. */
    key: text("key").primaryKey(),
    /** Requests counted in the current window, refused ones included. */
    count: integer("count").notNull(),
    /** Unix milliseconds the window opened. */
    windowStart: integer("window_start").notNull(),
    /** Unix milliseconds the window closes and the count starts again. */
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("auth_rate_limits_expires_at_idx").on(table.expiresAt)],
);
