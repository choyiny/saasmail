import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestSender,
  createTestTemplate,
  authFetch,
  getDb,
} from "./helpers";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { eq } from "drizzle-orm";

describe("sequences router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  async function createSequenceWithTemplates() {
    await createTestTemplate({ slug: "welcome" });
    await createTestTemplate({
      slug: "follow-up",
      name: "Follow Up",
      subject: "Follow up",
      bodyHtml: "<p>Following up</p>",
    });

    const res = await authFetch("/api/sequences", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "Onboarding",
        steps: [
          { order: 1, templateSlug: "welcome", delayHours: 0 },
          { order: 2, templateSlug: "follow-up", delayHours: 24 },
        ],
      }),
    });
    return res.json();
  }

  describe("POST /api/sequences", () => {
    it("creates a sequence", async () => {
      await createTestTemplate({ slug: "welcome" });
      const res = await authFetch("/api/sequences", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          name: "Test Sequence",
          steps: [{ order: 1, templateSlug: "welcome", delayHours: 0 }],
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.name).toBe("Test Sequence");
      expect(data.steps).toHaveLength(1);
    });

    it("rejects sequence with missing template", async () => {
      const res = await authFetch("/api/sequences", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          name: "Bad Sequence",
          steps: [
            { order: 1, templateSlug: "nonexistent-template", delayHours: 0 },
          ],
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/sequences", () => {
    it("lists sequences", async () => {
      await createSequenceWithTemplates();
      const res = await authFetch("/api/sequences", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("Onboarding");
    });
  });

  describe("GET /api/sequences/:id", () => {
    it("returns sequence with parsed steps", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}`, {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.steps).toHaveLength(2);
    });

    it("returns 404 for missing sequence", async () => {
      const res = await authFetch("/api/sequences/nonexistent", {
        apiKey,
      });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/sequences/:id", () => {
    it("updates sequence name", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}`, {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ name: "Updated Name" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("Updated Name");
    });

    it("validates template slugs on step update", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}`, {
        apiKey,
        method: "PUT",
        body: JSON.stringify({
          steps: [{ order: 1, templateSlug: "nonexistent", delayHours: 0 }],
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/sequences/:id", () => {
    it("deletes a sequence with no active enrollments", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}`, {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("rejects deletion with active enrollments", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestSender({ id: "s1", email: "a@test.com" });

      // Enroll sender
      await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ senderId: "s1" }),
      });

      const res = await authFetch(`/api/sequences/${seq.id}`, {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/sequences/:id/enroll", () => {
    it("enrolls a sender and creates scheduled emails", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestSender({ id: "s1", email: "a@test.com" });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          senderId: "s1",
          variables: { customVar: "value" },
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.enrollment.status).toBe("active");
      expect(data.scheduledEmails).toHaveLength(2);
      expect(data.scheduledEmails[0].status).toBe("pending");
    });

    it("rejects enrollment for nonexistent sender", async () => {
      const seq = await createSequenceWithTemplates();
      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ senderId: "nonexistent" }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects duplicate enrollment for same sender", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestSender({ id: "s1", email: "a@test.com" });

      await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ senderId: "s1" }),
      });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ senderId: "s1" }),
      });
      expect(res.status).toBe(400);
    });

    it("supports skipSteps", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestSender({ id: "s1", email: "a@test.com" });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ senderId: "s1", skipSteps: [2] }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.scheduledEmails).toHaveLength(1);
      expect(data.scheduledEmails[0].stepOrder).toBe(1);
    });

    it("rejects if all steps skipped", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestSender({ id: "s1", email: "a@test.com" });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ senderId: "s1", skipSteps: [1, 2] }),
      });
      expect(res.status).toBe(400);
    });

    it("supports delayOverrides", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestSender({ id: "s1", email: "a@test.com" });

      const res = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          senderId: "s1",
          delayOverrides: { "2": 48 },
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      // Step 2 should have 48 hours delay from base instead of 24
      const step2 = data.scheduledEmails.find((e: any) => e.stepOrder === 2);
      const step1 = data.scheduledEmails.find((e: any) => e.stepOrder === 1);
      const diff = step2.scheduledAt - step1.scheduledAt;
      expect(diff).toBe(48 * 3600);
    });
  });

  describe("GET /api/sequences/senders/:senderId/enrollment", () => {
    it("returns null when no active enrollment", async () => {
      await createTestSender({ id: "s1", email: "a@test.com" });
      const res = await authFetch("/api/sequences/senders/s1/enrollment", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enrollment).toBeNull();
      expect(data.scheduledEmails).toEqual([]);
    });

    it("returns active enrollment with scheduled emails", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestSender({ id: "s1", email: "a@test.com" });

      await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ senderId: "s1" }),
      });

      const res = await authFetch("/api/sequences/senders/s1/enrollment", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enrollment).not.toBeNull();
      expect(data.sequenceName).toBe("Onboarding");
      expect(data.scheduledEmails).toHaveLength(2);
    });
  });

  describe("DELETE /api/sequences/enrollments/:enrollmentId", () => {
    it("cancels an active enrollment", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestSender({ id: "s1", email: "a@test.com" });

      const enrollRes = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ senderId: "s1" }),
      });
      const enrollData = await enrollRes.json();

      const res = await authFetch(
        `/api/sequences/enrollments/${enrollData.enrollment.id}`,
        { apiKey, method: "DELETE" },
      );
      expect(res.status).toBe(200);

      // Verify emails were cancelled
      const db = getDb();
      const emailRows = await db
        .select()
        .from(sequenceEmails)
        .where(eq(sequenceEmails.enrollmentId, enrollData.enrollment.id));
      for (const row of emailRows) {
        expect(row.status).toBe("cancelled");
      }
    });

    it("returns 404 for nonexistent enrollment", async () => {
      const res = await authFetch("/api/sequences/enrollments/nonexistent", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("rejects cancellation of non-active enrollment", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestSender({ id: "s1", email: "a@test.com" });

      const enrollRes = await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ senderId: "s1" }),
      });
      const enrollData = await enrollRes.json();

      // Cancel once
      await authFetch(
        `/api/sequences/enrollments/${enrollData.enrollment.id}`,
        { apiKey, method: "DELETE" },
      );

      // Try cancelling again
      const res = await authFetch(
        `/api/sequences/enrollments/${enrollData.enrollment.id}`,
        { apiKey, method: "DELETE" },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/sequences/:id/enrollments", () => {
    it("lists enrollments with sender info and step counts", async () => {
      const seq = await createSequenceWithTemplates();
      await createTestSender({ id: "s1", email: "a@test.com", name: "Alice" });

      await authFetch(`/api/sequences/${seq.id}/enroll`, {
        apiKey,
        method: "POST",
        body: JSON.stringify({ senderId: "s1" }),
      });

      const res = await authFetch(`/api/sequences/${seq.id}/enrollments`, {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].senderEmail).toBe("a@test.com");
      expect(data[0].senderName).toBe("Alice");
      expect(data[0].totalSteps).toBe(2);
      expect(data[0].sentSteps).toBe(0);
    });
  });
});
