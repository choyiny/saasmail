import { describe, it, expect, beforeAll, beforeEach } from "vitest";
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

describe("agent runs router", () => {
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
  });

  describe("GET /api/agents/runs", () => {
    it("lists runs", async () => {
      await createTestAgentRun({
        id: "run-1",
        assignmentId: "asgn-1",
        emailId: "email-1",
        personId: "sender-1",
      });
      const res = await authFetch("/api/agents/runs", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.runs).toHaveLength(1);
      expect(data.total).toBe(1);
    });

    it("filters by status", async () => {
      await createTestAgentRun({
        id: "run-1",
        assignmentId: "asgn-1",
        emailId: "email-1",
        personId: "sender-1",
        status: "succeeded",
      });
      await createTestAgentRun({
        id: "run-2",
        assignmentId: "asgn-1",
        emailId: "email-1",
        personId: "sender-1",
        status: "failed",
      });

      const res = await authFetch("/api/agents/runs?status=failed", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.runs).toHaveLength(1);
      expect(data.runs[0].status).toBe("failed");
    });

    it("paginates results", async () => {
      await createTestAgentRun({
        id: "run-1",
        assignmentId: "asgn-1",
        emailId: "email-1",
        personId: "sender-1",
      });
      await createTestAgentRun({
        id: "run-2",
        assignmentId: "asgn-1",
        emailId: "email-1",
        personId: "sender-1",
      });

      const res = await authFetch("/api/agents/runs?limit=1&offset=0", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.runs).toHaveLength(1);
      expect(data.total).toBe(2);
    });
  });

  describe("GET /api/agents/runs/:id", () => {
    it("returns a single run", async () => {
      await createTestAgentRun({
        id: "run-1",
        assignmentId: "asgn-1",
        emailId: "email-1",
        personId: "sender-1",
      });
      const res = await authFetch("/api/agents/runs/run-1", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe("run-1");
    });

    it("returns 404 for missing run", async () => {
      const res = await authFetch("/api/agents/runs/nonexistent", { apiKey });
      expect(res.status).toBe(404);
    });
  });
});
