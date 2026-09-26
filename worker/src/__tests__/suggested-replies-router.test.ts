import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { suggestedReplies } from "../db/suggested-replies.schema";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

beforeAll(applyMigrations);
beforeEach(cleanDb);

async function seedSuggestion(options?: {
  id?: string;
  emailId?: string;
  status?: "pending" | "used" | "dismissed";
}) {
  const id = options?.id ?? "suggestion-1";
  const emailId = options?.emailId ?? "suggestion-email-1";
  const now = Math.floor(Date.now() / 1000);
  await createTestPerson({ id: "suggestion-person" });
  await createTestEmail({
    id: emailId,
    personId: "suggestion-person",
    recipient: "support@example.com",
  });
  await getDb()
    .insert(suggestedReplies)
    .values({
      id,
      emailId,
      inbox: "support@example.com",
      bodyText: "Suggested body",
      model: "test-model",
      status: options?.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    });
  return { id, emailId };
}

type SuggestionResponse = {
  suggestion: { id: string; emailId: string } | null;
};

type SuggestionStatusResponse = { status: string };

async function jsonBody<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

describe("suggested replies routes", () => {
  it("returns a pending suggestion for an allowed inbox and null after use", async () => {
    const admin = await createTestUser({
      id: "suggest-route-admin",
      email: "suggest-route-admin@example.com",
      role: "admin",
    });
    const { id, emailId } = await seedSuggestion();

    let res = await authFetch(
      `/api/suggested-replies?emailId=${encodeURIComponent(emailId)}`,
      { apiKey: admin.apiKey },
    );
    expect(res.status).toBe(200);
    expect((await jsonBody<SuggestionResponse>(res)).suggestion).toMatchObject({
      id,
      emailId,
    });

    res = await authFetch(`/api/suggested-replies/${id}/use`, {
      apiKey: admin.apiKey,
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect((await jsonBody<SuggestionStatusResponse>(res)).status).toBe("used");

    const again = await authFetch(`/api/suggested-replies/${id}/use`, {
      apiKey: admin.apiKey,
      method: "POST",
    });
    expect(again.status).toBe(200);
    expect((await jsonBody<SuggestionStatusResponse>(again)).status).toBe(
      "used",
    );

    res = await authFetch(
      `/api/suggested-replies?emailId=${encodeURIComponent(emailId)}`,
      { apiKey: admin.apiKey },
    );
    expect((await jsonBody<SuggestionResponse>(res)).suggestion).toBeNull();
  });

  it("returns 404 when the caller cannot see the inbox", async () => {
    const member = await createTestUser({
      id: "suggest-route-member",
      email: "suggest-route-member@example.com",
      role: "member",
    });
    const { id, emailId } = await seedSuggestion({
      id: "denied-suggestion",
      emailId: "denied-email",
    });

    const get = await authFetch(
      `/api/suggested-replies?emailId=${encodeURIComponent(emailId)}`,
      { apiKey: member.apiKey },
    );
    expect(get.status).toBe(404);

    const use = await authFetch(`/api/suggested-replies/${id}/use`, {
      apiKey: member.apiKey,
      method: "POST",
    });
    expect(use.status).toBe(404);
  });

  it("allows an assigned member to dismiss idempotently and never use it later", async () => {
    const admin = await createTestUser({
      id: "suggest-perm-admin",
      email: "suggest-perm-admin@example.com",
      role: "admin",
    });
    const member = await createTestUser({
      id: "suggest-perm-member",
      email: "suggest-perm-member@example.com",
      role: "member",
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(inboxPermissions).values({
      userId: member.userId,
      email: "support@example.com",
      createdAt: now,
      createdBy: admin.userId,
    });
    const { id } = await seedSuggestion({
      id: "dismiss-suggestion",
      emailId: "dismiss-email",
    });

    const first = await authFetch(`/api/suggested-replies/${id}/dismiss`, {
      apiKey: member.apiKey,
      method: "POST",
    });
    expect(first.status).toBe(200);
    expect((await jsonBody<SuggestionStatusResponse>(first)).status).toBe(
      "dismissed",
    );

    const again = await authFetch(`/api/suggested-replies/${id}/dismiss`, {
      apiKey: member.apiKey,
      method: "POST",
    });
    expect(again.status).toBe(200);
    expect((await jsonBody<SuggestionStatusResponse>(again)).status).toBe(
      "dismissed",
    );

    const use = await authFetch(`/api/suggested-replies/${id}/use`, {
      apiKey: member.apiKey,
      method: "POST",
    });
    expect(use.status).toBe(409);

    const [stored] = await getDb()
      .select()
      .from(suggestedReplies)
      .where(eq(suggestedReplies.id, id));
    expect(stored.status).toBe("dismissed");
  });
});
