import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { emailChanges } from "../jmap/changes";
import { currentJmapState } from "../jmap/state";
import { publicAccountId } from "../jmap/public-ids";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import {
  INBOX,
  changeRows,
  insertJmapSentRow,
  insertTestContent,
  insertTestDraft,
  insertTestSubmission,
  seedAccount,
} from "./jmap-submission-fixtures";

async function run(sqlText: string, ...binds: unknown[]) {
  await env.DB.prepare(sqlText)
    .bind(...binds)
    .run();
}

describe("change triggers for hidden and aliased Sent rows", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  async function hiddenSentRow() {
    const { authorId } = await seedAccount();
    await insertTestContent({ id: "c1", userId: authorId });
    await insertTestDraft({ id: "d1", userId: authorId, contentId: "c1" });
    await insertTestSubmission({
      id: "e1",
      userId: authorId,
      draftId: "d1",
      contentId: "c1",
      sentEmailId: "s1",
      attemptState: "accepted",
      onSuccessState: "pending",
    });
    await insertJmapSentRow({ id: "s1", contentId: "c1" });
    return { authorId };
  }

  it("writes nothing while the Sent row is hidden", async () => {
    const { authorId } = await hiddenSentRow();
    await run(`UPDATE sent_emails SET status = 'retrying' WHERE id = 's1'`);
    await run(
      `INSERT INTO message_user_state (user_id, message_kind, message_id, seen_at, starred_at, updated_at)
       VALUES (?, 'sent', 's1', NULL, 1, 1)`,
      authorId,
    );
    await run(
      `INSERT INTO mailbox_message_state (inbox, message_kind, message_id, archived_at, spam_at, trashed_at, updated_by, updated_at)
       VALUES (?, 'sent', 's1', NULL, NULL, 1, NULL, 1)`,
      INBOX,
    );
    await run(
      `INSERT INTO message_mailboxes (message_kind, message_id, mailbox_id, added_by, added_at)
       VALUES ('sent', 's1', 'f1', NULL, 1)`,
    );
    expect(await changeRows("sent:s1")).toEqual([]);
  });

  it("writes normally once revealed", async () => {
    await hiddenSentRow();
    await run(
      `UPDATE jmap_submissions SET on_success_state = 'applied' WHERE id = 'e1'`,
    );
    await run(`UPDATE sent_emails SET status = 'failed' WHERE id = 's1'`);
    expect((await changeRows("sent:s1")).map((row) => row.op)).toEqual(["u"]);
  });

  it("writes an aliased row as its draft id", async () => {
    const { authorId } = await hiddenSentRow();
    await run(
      `UPDATE sent_emails SET jmap_email_id = 'd1', jmap_received_at = 5 WHERE id = 's1'`,
    );
    await run(
      `UPDATE jmap_submissions SET on_success_state = 'applied' WHERE id = 'e1'`,
    );
    await run(`UPDATE sent_emails SET status = 'failed' WHERE id = 's1'`);
    await run(
      `INSERT INTO message_user_state (user_id, message_kind, message_id, seen_at, starred_at, updated_at)
       VALUES (?, 'sent', 's1', NULL, 1, 1)`,
      authorId,
    );
    await run(`DELETE FROM sent_emails WHERE id = 's1'`);
    expect(await changeRows("sent:s1")).toEqual([]);
    const draftRows = await changeRows("draft:d1");
    // The draft's own insert 'c' (PR 4 trigger), then the Sent row's u, u, d.
    expect(draftRows.map((row) => row.op)).toEqual(["c", "u", "u", "d"]);
  });

  it("skips the draft delete row when alias_delete is set", async () => {
    await hiddenSentRow();
    await run(`UPDATE jmap_drafts SET alias_delete = 1 WHERE id = 'd1'`);
    await run(`DELETE FROM jmap_drafts WHERE id = 'd1'`);
    expect((await changeRows("draft:d1")).map((row) => row.op)).toEqual(["c"]);
  });

  it("still writes the draft delete row otherwise", async () => {
    await hiddenSentRow();
    await run(`DELETE FROM jmap_submissions WHERE id = 'e1'`);
    await run(`DELETE FROM jmap_drafts WHERE id = 'd1'`);
    expect((await changeRows("draft:d1")).map((row) => row.op)).toEqual([
      "c",
      "d",
    ]);
  });

  it("hides a shared row from the user it excludes", async () => {
    const { authorId, memberId } = await seedAccount();
    // Typed as AllowedInboxes: `as const` would make `inboxes` a readonly
    // tuple, which AllowedInboxes rejects.
    const admin: AllowedInboxes = { isAdmin: true };
    const member: AllowedInboxes = { isAdmin: false, inboxes: [INBOX] };
    const authorSince = (await currentJmapState(getDb(), admin, authorId))
      .state;
    const memberSince = (await currentJmapState(getDb(), member, memberId))
      .state;
    await run(
      `INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, exclude_user_id, op, created_at)
       VALUES ('email', 'draft:dx', ?, NULL, ?, 'c', CAST(strftime('%s','now') AS INTEGER))`,
      INBOX,
      authorId,
    );
    const forAuthor = (await emailChanges(
      getDb(),
      admin,
      authorId,
      publicAccountId(authorId),
      { sinceState: authorSince },
    )) as Record<string, string[]>;
    const forMember = (await emailChanges(
      getDb(),
      member,
      memberId,
      publicAccountId(memberId),
      { sinceState: memberSince },
    )) as Record<string, string[]>;
    expect(forAuthor.created).toEqual([]);
    expect(forMember.created).toEqual(["Ddx"]);
  });
});
