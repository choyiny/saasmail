import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  authFetch,
  createTestUser,
  getDb,
  applyMigrations,
  cleanDb,
} from "./helpers";
import { suppressions } from "../db/suppressions.schema";

beforeAll(applyMigrations);
beforeEach(cleanDb);

describe("suppressions router", () => {
  it("POST /api/suppressions creates a manual entry", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const r = await authFetch("/api/suppressions", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      email: string;
      reason: string;
      source: string;
    };
    expect(body).toMatchObject({ email: "alice@example.com", reason: "manual" });
    expect(body.source).toMatch(/^admin:/);
  });

  it("POST /api/suppressions is idempotent for duplicate email", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await authFetch("/api/suppressions", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    const r = await authFetch("/api/suppressions", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    expect([200, 201]).toContain(r.status);
    const rows = await getDb().query.suppressions.findMany();
    expect(rows.filter((row) => row.email === "alice@example.com")).toHaveLength(
      1,
    );
  });

  it("POST /api/suppressions lowercases the input email", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const r = await authFetch("/api/suppressions", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "ALICE@EXAMPLE.COM" }),
    });
    const body = (await r.json()) as { email: string };
    expect(body.email).toBe("alice@example.com");
  });

  it("GET /api/suppressions returns paginated list newest-first", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    // Insert 3 rows with distinct timestamps — newest (i=0) first.
    for (let i = 0; i < 3; i++) {
      await db.insert(suppressions).values({
        id: "s" + i,
        email: "u" + i + "@example.com",
        reason: "manual",
        source: "test",
        note: null,
        createdAt: now - i * 60,
      });
    }
    const r = await authFetch("/api/suppressions", { apiKey });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{ email: string }>;
      nextCursor: string | null;
    };
    expect(body.items).toHaveLength(3);
    expect(body.items[0].email).toBe("u0@example.com");
    expect(body.items[2].email).toBe("u2@example.com");
    expect(body.nextCursor).toBeNull();
  });

  it("DELETE /api/suppressions/:id removes the row", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await getDb().insert(suppressions).values({
      id: "s1",
      email: "alice@example.com",
      reason: "manual",
      source: "test",
      note: null,
      createdAt: Math.floor(Date.now() / 1000),
    });
    const r = await authFetch("/api/suppressions/s1", {
      apiKey,
      method: "DELETE",
    });
    expect(r.status).toBe(200);
    const rows = await getDb().query.suppressions.findMany();
    expect(rows).toHaveLength(0);
  });

  it("DELETE is idempotent (no 404 on missing id)", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const r = await authFetch("/api/suppressions/does-not-exist", {
      apiKey,
      method: "DELETE",
    });
    expect(r.status).toBe(200);
  });

  it("rejects unauthenticated requests", async () => {
    const r = await authFetch("/api/suppressions");
    expect([401, 403]).toContain(r.status);
  });

  it("rejects non-admin authenticated requests", async () => {
    const { apiKey } = await createTestUser({
      role: "member",
      email: "regular@example.com",
    });
    const r = await authFetch("/api/suppressions", { apiKey });
    expect([401, 403]).toContain(r.status);
  });
});
