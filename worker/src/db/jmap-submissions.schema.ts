import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * One row per EmailSubmission create (spec §3.4, §4). `claimed` is the durable
 * intention written before the provider call and the only state JMAP never
 * exposes. A delayed send (RFC 4865 FUTURERELEASE) is `scheduled` until its
 * release claims it (`releasing`), then `accepted`. `email_id` keeps the
 * original public D… id after the draft is gone (RFC 8621 §7).
 */
export const jmapSubmissions = sqliteTable(
  "jmap_submissions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    attemptState: text("attempt_state", {
      enum: ["claimed", "scheduled", "releasing", "accepted"],
    }).notNull(),
    onSuccessState: text("on_success_state", {
      enum: ["pending", "applied"],
    }).notNull(),
    draftId: text("draft_id").notNull(),
    contentId: text("content_id").notNull(),
    identityId: text("identity_id").notNull(),
    identityEmail: text("identity_email").notNull(),
    emailId: text("email_id").notNull(),
    threadId: text("thread_id").notNull(),
    sentEmailId: text("sent_email_id").notNull().unique(),
    envelopeJson: text("envelope_json").notNull(),
    onSuccessMode: text("on_success_mode", {
      enum: ["none", "update", "destroy", "both"],
    }).notNull(),
    onSuccessPatchJson: text("on_success_patch_json"),
    /** The exact From header of the first attempt; retries reuse it (spec §10.1). */
    fromHeader: text("from_header"),
    sendAt: integer("send_at").notNull(),
    /** `pending` until the send is irreversible, then `final`; or `canceled`. */
    undoStatus: text("undo_status", { enum: ["pending", "final", "canceled"] })
      .notNull()
      .default("final"),
    /** When a delayed send's release claimed it (`releasing`); recovery ages it. */
    releasedAt: integer("released_at"),
    /**
     * 1 when the web Outbox canceled this scheduled send and still owes the move
     * of its Email back to Drafts; recovery finishes a move that failed.
     */
    restoreToDrafts: integer("restore_to_drafts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("jmap_submissions_user_send_idx").on(table.userId, table.sendAt),
    index("jmap_submissions_attempt_idx").on(
      table.attemptState,
      table.createdAt,
    ),
    index("jmap_submissions_on_success_idx").on(table.onSuccessState),
  ],
);
