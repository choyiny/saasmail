import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import { jmapChanges } from "../db/jmap-changes.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";

function submissionRow(
  id: string,
  userId: string,
  attemptState: "claimed" | "accepted",
) {
  return {
    id,
    userId,
    attemptState,
    onSuccessState: "pending" as const,
    draftId: "draft-1",
    contentId: "content-1",
    identityId: "iIdentity",
    identityEmail: "mine@saasmail.test",
    emailId: "Ddraft-1",
    threadId: "Tddraft-1",
    sentEmailId: `sent-${id}`,
    envelopeJson: "{}",
    onSuccessMode: "none" as const,
    sendAt: 100,
    createdAt: 100,
  };
}

describe("jmap_submissions change triggers", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("logs accepted submissions only, and their deletes", async () => {
    const { userId } = await createTestUser({ id: "sub-trigger-user" });
    const db = getDb();
    await db
      .insert(jmapSubmissions)
      .values(submissionRow("s1", userId, "claimed"));
    expect(await db.select().from(jmapChanges)).toHaveLength(0);

    await db
      .update(jmapSubmissions)
      .set({ attemptState: "accepted", onSuccessState: "applied" })
      .where(eq(jmapSubmissions.id, "s1"));
    await db
      .insert(jmapSubmissions)
      .values(submissionRow("s2", userId, "accepted"));
    await db
      .insert(jmapSubmissions)
      .values(submissionRow("s3", userId, "claimed"));
    await db.delete(jmapSubmissions).where(eq(jmapSubmissions.id, "s1"));
    await db.delete(jmapSubmissions).where(eq(jmapSubmissions.id, "s3"));

    const rows = await db.select().from(jmapChanges);
    expect(
      rows.map((row) => [
        row.objectType,
        row.objectId,
        row.inbox,
        row.userId,
        row.op,
      ]),
    ).toEqual([
      ["submission", "submission:s1", "mine@saasmail.test", userId, "c"],
      ["submission", "submission:s2", "mine@saasmail.test", userId, "c"],
      ["submission", "submission:s1", "mine@saasmail.test", userId, "d"],
    ]);
  });
});
