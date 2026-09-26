import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Images referenced by block-authored newsletter templates.
 *
 * Separate from `attachments` because the access model is the opposite one.
 * An attachment is private: `GET /api/attachments/{id}` is authenticated,
 * scoped to the caller's allowed inboxes, and served `Cache-Control: private`.
 * A newsletter image has to be fetchable by a stranger's mail client months
 * after the send, with no session and no API key.
 *
 * **The id is the only secret.** `GET /assets/n/{id}` performs no
 * authorization, so the id must be unguessable — enumerable ids would make
 * every operator's newsletter imagery walkable. It is 128 bits of randomness,
 * not a nanoid and not a counter.
 *
 * Rows are never garbage-collected. An image referenced by a sent campaign has
 * to outlive the template that introduced it: the campaign's frozen
 * `htmlSnapshot` still points at that URL when a subscriber opens the mail
 * later. See `docs/newsletters.md`.
 */
export const newsletterAssets = sqliteTable(
  "newsletter_assets",
  {
    id: text("id").primaryKey(),
    r2Key: text("r2_key").notNull(),
    /** Sniffed from the file header on upload — never the declared type. */
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** Hex SHA-256 of the bytes; re-uploading the same file reuses the row. */
    sha256: text("sha256").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    // Dedupe lookup on upload.
    index("newsletter_assets_sha256_idx").on(table.sha256),
  ],
);

export type NewsletterAsset = typeof newsletterAssets.$inferSelect;
