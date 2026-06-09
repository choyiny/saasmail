import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, authFetch, cleanDb, createTestUser } from "./helpers";

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhooks router", () => {
  it("GET returns empty config by default", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch("/api/webhook", { apiKey });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "", hasSecret: false });
  });

  it("PUT sets url+secret; GET reports hasSecret without echoing it", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const put = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook.d.com", secret: "shh" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      url: "https://hook.d.com",
      hasSecret: true,
    });

    const get = await authFetch("/api/webhook", { apiKey });
    const body = (await get.json()) as Record<string, unknown>;
    expect(body).toEqual({ url: "https://hook.d.com", hasSecret: true });
    expect(JSON.stringify(body)).not.toContain("shh");
  });

  it("PUT with omitted secret preserves the existing secret", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook.d.com", secret: "shh" }),
    });
    const put2 = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook2.d.com" }),
    });
    expect(await put2.json()).toEqual({
      url: "https://hook2.d.com",
      hasSecret: true,
    });
  });

  it("PUT with blank url disables the webhook", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook.d.com", secret: "shh" }),
    });
    const clear = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "" }),
    });
    expect(await clear.json()).toEqual({ url: "", hasSecret: false });
  });

  it("allows http:// urls (no scheme restriction)", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const put = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "http://localhost:5678/webhook" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      url: "http://localhost:5678/webhook",
      hasSecret: false,
    });
  });

  it("POST /test returns 400 when unconfigured", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch("/api/webhook/test", { apiKey, method: "POST" });
    expect(res.status).toBe(400);
  });

  it("POST /test delivers to the configured URL", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook.d.com" }),
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const res = await authFetch("/api/webhook/test", { apiKey, method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hook.d.com",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns 403 for a non-admin caller", async () => {
    const { apiKey } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "member@example.com",
    });
    const res = await authFetch("/api/webhook", { apiKey });
    expect(res.status).toBe(403);
  });
});
