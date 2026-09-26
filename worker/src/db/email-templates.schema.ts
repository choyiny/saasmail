import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import type { BlockDocument } from "../lib/blocks/schema";

export const emailTemplates = sqliteTable("email_templates", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  /**
   * The rendering source for **every** consumer — campaign snapshots, sequence
   * sends, the template send API, `analyzeTemplate`, link rewriting. Block
   * templates compile into it at save time, so nothing downstream needs to know
   * that blocks exist.
   */
  bodyHtml: text("body_html").notNull(),
  /**
   * How the author edits this template. `html` is the raw-HTML editor that has
   * always existed; `block` is the visual editor, whose document lives in
   * `bodyJson` and is compiled into `bodyHtml` on write.
   *
   * The default is what makes the migration purely additive: every row that
   * existed before this column became an `html` template with no backfill.
   */
  format: text("format", { enum: ["html", "block"] })
    .notNull()
    .default("html"),
  /** The block document, for `format = 'block'`. Null for HTML templates. */
  bodyJson: text("body_json", { mode: "json" }).$type<BlockDocument>(),
  fromAddress: text("from_address"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
