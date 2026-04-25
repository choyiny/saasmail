import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getDb } from "./helpers";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestAgentDefinition,
  createTestAgentAssignment,
  createTestAgentRun,
  createTestPerson,
  createTestEmail,
  authFetch,
} from "./helpers";
import { drafts } from "../db/drafts.schema";

async function createTestDraft(
  opts: {
    id?: string;
    personId?: string;
    agentRunId?: string;
  } = {},
) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const draft = {
    id: opts.id ?? "draft-1",
    personId: opts.personId ?? "sender-1",
    agentRunId: opts.agentRunId ?? "run-1",
    fromAddress: "inbox@saasmail.test",
    toAddress: "alice@example.com",
    subject: "Hello from agent",
    bodyHtml: "<p>Hi there!</p>",
    inReplyTo: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(drafts).values(draft);
  return draft;
}

describe("drafts router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    await createTestPerson({ id: "sender-1" });
    await createTestEmail({ id: "email-1", personId: "sender-1" });
    await createTestAgentDefinition({ id: "def-1" });
    await createTestAgentAssignment({ id: "asgn-1", agentId: "def-1" });
    await createTestAgentRun({
      id: "run-1",
      assignmentId: "asgn-1",
      emailId: "email-1",
      personId: "sender-1",
    });
  });

  describe("GET /api/drafts", () => {
    it("lists drafts", async () => {
      await createTestDraft({ id: "draft-1" });
      const res = await authFetch("/api/drafts", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].subject).toBe("Hello from agent");
    });

    it("filters by personId", async () => {
      await createTestPerson({ id: "sender-2", email: "bob@example.com" });
      await createTestEmail({
        id: "email-2",
        personId: "sender-2",
        recipient: "inbox@saasmail.test",
        messageId: "msg-2@example.com",
      });
      await createTestAgentRun({
        id: "run-2",
        assignmentId: "asgn-1",
        emailId: "email-2",
        personId: "sender-2",
      });
      await createTestDraft({
        id: "draft-1",
        personId: "sender-1",
        agentRunId: "run-1",
      });
      await createTestDraft({
        id: "draft-2",
        personId: "sender-2",
        agentRunId: "run-2",
      });

      const res = await authFetch("/api/drafts?personId=sender-1", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].personId).toBe("sender-1");
    });
  });

  describe("GET /api/drafts/:id", () => {
    it("returns a draft", async () => {
      await createTestDraft({ id: "draft-1" });
      const res = await authFetch("/api/drafts/draft-1", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe("draft-1");
    });

    it("returns 404 for missing draft", async () => {
      const res = await authFetch("/api/drafts/nonexistent", { apiKey });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/drafts/:id", () => {
    it("deletes a draft", async () => {
      await createTestDraft({ id: "draft-1" });
      const res = await authFetch("/api/drafts/draft-1", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
    });

    it("returns 404 for missing draft", async () => {
      const res = await authFetch("/api/drafts/nonexistent", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
