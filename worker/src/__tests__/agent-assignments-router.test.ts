import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestAgentDefinition,
  createTestAgentAssignment,
  createTestTemplate,
  authFetch,
} from "./helpers";

describe("agent assignments router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("POST /api/agents/assignments", () => {
    it("creates an assignment", async () => {
      await createTestAgentDefinition({ id: "def-1" });
      await createTestTemplate({
        slug: "welcome",
        subject: "Hello {{greeting}}",
        bodyHtml: "<p>{{greeting}}</p>",
      });

      const res = await authFetch("/api/agents/assignments", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          agentId: "def-1",
          mailbox: "inbox@test.com",
          templateSlug: "welcome",
          mode: "every_mail_reply",
          isActive: true,
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.agentId).toBe("def-1");
      expect(data.templateSlug).toBe("welcome");
      expect(data.mode).toBe("every_mail_reply");
      expect(data.isActive).toBe(true);
    });

    it("returns 422 when template uses vars not in outputSchema", async () => {
      await createTestAgentDefinition({ id: "def-1" });
      // Template uses {{unknownVar}} but agent only has {{greeting}} in schema
      await createTestTemplate({
        slug: "bad-template",
        subject: "Hello {{unknownVar}}",
        bodyHtml: "<p>test</p>",
      });

      const res = await authFetch("/api/agents/assignments", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          agentId: "def-1",
          mailbox: "inbox@test.com",
          templateSlug: "bad-template",
          mode: "every_mail_reply",
          isActive: true,
        }),
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.missing).toContain("unknownVar");
    });

    it("returns 409 on duplicate active scope", async () => {
      await createTestAgentDefinition({ id: "def-1" });
      await createTestTemplate({
        slug: "welcome",
        subject: "Hi",
        bodyHtml: "<p>hi</p>",
      });
      await createTestAgentAssignment({
        id: "asgn-1",
        agentId: "def-1",
        mailbox: "inbox@test.com",
        personId: null,
        templateSlug: "welcome",
      });

      const res = await authFetch("/api/agents/assignments", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          agentId: "def-1",
          mailbox: "inbox@test.com",
          templateSlug: "welcome",
          mode: "every_mail_reply",
          isActive: true,
        }),
      });
      expect(res.status).toBe(409);
    });

    it("returns 404 when agent not found", async () => {
      await createTestTemplate({
        slug: "welcome",
        subject: "Hi",
        bodyHtml: "<p>hi</p>",
      });
      const res = await authFetch("/api/agents/assignments", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          agentId: "nonexistent",
          templateSlug: "welcome",
          mode: "every_mail_reply",
          isActive: true,
        }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/agents/assignments", () => {
    it("lists assignments with agent and template names", async () => {
      await createTestAgentDefinition({ id: "def-1", name: "My Agent" });
      await createTestTemplate({ slug: "welcome", name: "Welcome" });
      await createTestAgentAssignment({
        id: "asgn-1",
        agentId: "def-1",
        templateSlug: "welcome",
      });

      const res = await authFetch("/api/agents/assignments", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].agentName).toBe("My Agent");
      expect(data[0].templateName).toBe("Welcome");
    });

    it("filters by agentId", async () => {
      await createTestAgentDefinition({ id: "def-1" });
      await createTestAgentDefinition({ id: "def-2", name: "Other Agent" });
      await createTestTemplate({
        slug: "welcome",
        subject: "Hi",
        bodyHtml: "<p>hi</p>",
      });
      await createTestAgentAssignment({
        id: "asgn-1",
        agentId: "def-1",
        templateSlug: "welcome",
      });
      await createTestAgentAssignment({
        id: "asgn-2",
        agentId: "def-2",
        mailbox: "other@test.com",
        templateSlug: "welcome",
      });

      const res = await authFetch("/api/agents/assignments?agentId=def-1", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].agentId).toBe("def-1");
    });
  });

  describe("DELETE /api/agents/assignments/:id", () => {
    it("deletes an assignment", async () => {
      await createTestAgentDefinition({ id: "def-1" });
      await createTestTemplate({
        slug: "welcome",
        subject: "Hi",
        bodyHtml: "<p>hi</p>",
      });
      await createTestAgentAssignment({
        id: "asgn-1",
        agentId: "def-1",
        templateSlug: "welcome",
      });

      const res = await authFetch("/api/agents/assignments/asgn-1", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
    });

    it("returns 404 for missing assignment", async () => {
      const res = await authFetch("/api/agents/assignments/nonexistent", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
