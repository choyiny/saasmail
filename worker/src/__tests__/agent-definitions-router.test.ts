import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestAgentDefinition,
  createTestAgentAssignment,
  authFetch,
} from "./helpers";

describe("agent definitions router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("POST /api/agents/definitions", () => {
    it("creates an agent definition", async () => {
      const res = await authFetch("/api/agents/definitions", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          name: "Welcome Agent",
          modelId: "@cf/meta/llama-3.3-70b-instruct",
          systemPrompt: "You are a helpful assistant.",
          outputFields: [{ name: "greeting", description: "A greeting" }],
          maxRunsPerHour: 5,
          isActive: true,
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.name).toBe("Welcome Agent");
      expect(data.outputFields).toEqual([
        { name: "greeting", description: "A greeting" },
      ]);
      expect(data.isActive).toBe(true);
      expect(data.maxRunsPerHour).toBe(5);
    });

    it("rejects empty outputFields", async () => {
      const res = await authFetch("/api/agents/definitions", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          name: "Bad Agent",
          systemPrompt: "You are helpful.",
          outputFields: [],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects outputField name with spaces", async () => {
      const res = await authFetch("/api/agents/definitions", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          name: "Bad Agent",
          systemPrompt: "You are helpful.",
          outputFields: [{ name: "bad name", description: "x" }],
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/agents/definitions", () => {
    it("lists agent definitions", async () => {
      await createTestAgentDefinition({ id: "def-1", name: "Agent One" });
      await createTestAgentDefinition({ id: "def-2", name: "Agent Two" });
      const res = await authFetch("/api/agents/definitions", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(2);
      expect(data[0].outputFields).toBeDefined();
    });

    it("returns empty array when no definitions", async () => {
      const res = await authFetch("/api/agents/definitions", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });
  });

  describe("GET /api/agents/definitions/:id", () => {
    it("returns a definition by id", async () => {
      await createTestAgentDefinition({ id: "def-1" });
      const res = await authFetch("/api/agents/definitions/def-1", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe("def-1");
      expect(data.outputFields).toBeInstanceOf(Array);
    });

    it("returns 404 for missing id", async () => {
      const res = await authFetch("/api/agents/definitions/nonexistent", {
        apiKey,
      });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/agents/definitions/:id", () => {
    it("updates a definition", async () => {
      await createTestAgentDefinition({ id: "def-1", name: "Original" });
      const res = await authFetch("/api/agents/definitions/def-1", {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ name: "Updated", isActive: false }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("Updated");
      expect(data.isActive).toBe(false);
    });

    it("returns 404 for missing id", async () => {
      const res = await authFetch("/api/agents/definitions/nonexistent", {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ name: "X" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/agents/definitions/:id", () => {
    it("deletes a definition with no assignments", async () => {
      await createTestAgentDefinition({ id: "def-1" });
      const res = await authFetch("/api/agents/definitions/def-1", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("returns 409 when assignments exist", async () => {
      await createTestAgentDefinition({ id: "def-1" });
      await createTestAgentAssignment({ id: "asgn-1", agentId: "def-1" });
      const res = await authFetch("/api/agents/definitions/def-1", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(409);
    });

    it("returns 404 for missing id", async () => {
      const res = await authFetch("/api/agents/definitions/nonexistent", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
