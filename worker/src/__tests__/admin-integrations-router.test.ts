import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { appSettings } from "../db/app-settings.schema";
import { loadProviderConfig } from "../lib/oauth-providers";
import {
  getDb,
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
} from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

const bindings = env as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

/** Remove an env binding for one test; restored in afterEach. */
function unsetBinding(name: string) {
  if (!(name in saved)) saved[name] = bindings[name];
  delete bindings[name];
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) bindings[name] = value;
  for (const name of Object.keys(saved)) delete saved[name];
});

type Provider = {
  provider: string;
  configured: boolean;
  source: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  tenant: string | null;
  redirectUri: string;
  connectedMailboxes: number;
};

async function list(apiKey: string) {
  const res = await authFetch("/api/admin/integrations", { apiKey });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    encryptionKeyConfigured: boolean;
    providers: Provider[];
  };
}

function put(apiKey: string, provider: string, body: unknown) {
  return authFetch(`/api/admin/integrations/${provider}`, {
    apiKey,
    method: "PUT",
    body: JSON.stringify(body),
  });
}

async function storedValue(provider: string) {
  const [row] = await getDb()
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, `oauth_provider:${provider}`));
  return row?.value ?? null;
}

describe("admin integrations — provider OAuth settings", () => {
  it("reports Google as configured from env vars, and Microsoft as not set up", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const body = await list(apiKey);

    expect(body.encryptionKeyConfigured).toBe(true);
    const google = body.providers.find((p) => p.provider === "google")!;
    expect(google).toMatchObject({
      configured: true,
      source: "env",
      clientId: "test-google-client-id",
      hasClientSecret: true,
    });
    expect(google.redirectUri).toMatch(/\/api\/admin\/gmail\/callback$/);
    const microsoft = body.providers.find((p) => p.provider === "microsoft")!;
    expect(microsoft).toMatchObject({
      configured: false,
      source: null,
      clientId: null,
      hasClientSecret: false,
    });
    expect(microsoft.redirectUri).toMatch(/\/api\/admin\/outlook\/callback$/);
  });

  it("stores the secret sealed, never returns it, and prefers it over env vars", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });

    const res = await put(apiKey, "google", {
      clientId: "db-client.apps.googleusercontent.com",
      clientSecret: "super-secret-value",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("super-secret-value");
    expect(JSON.parse(text)).toMatchObject({
      configured: true,
      source: "database",
      clientId: "db-client.apps.googleusercontent.com",
      hasClientSecret: true,
    });

    expect(await storedValue("google")).not.toContain("super-secret-value");
    expect(JSON.stringify(await list(apiKey))).not.toContain(
      "super-secret-value",
    );

    const cfg = await loadProviderConfig(getDb(), env, "google");
    expect(cfg).toMatchObject({
      clientId: "db-client.apps.googleusercontent.com",
      clientSecret: "super-secret-value",
      source: "database",
    });
  });

  it("keeps the stored secret when an update leaves it out", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await put(apiKey, "microsoft", {
      clientId: "ms-client",
      clientSecret: "ms-secret",
    });

    const res = await put(apiKey, "microsoft", {
      clientId: "ms-client",
      tenant: "contoso.onmicrosoft.com",
    });
    expect(res.status).toBe(200);

    const cfg = await loadProviderConfig(getDb(), env, "microsoft");
    expect(cfg).toMatchObject({
      clientSecret: "ms-secret",
      tenant: "contoso.onmicrosoft.com",
    });
  });

  it("refuses an update with no secret when none is stored", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await put(apiKey, "microsoft", { clientId: "ms-client" });
    expect(res.status).toBe(400);
    expect(await storedValue("microsoft")).toBeNull();
  });

  it("refuses to store anything without TOKEN_ENCRYPTION_KEY, and says how to fix it", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    unsetBinding("TOKEN_ENCRYPTION_KEY");

    const res = await put(apiKey, "google", {
      clientId: "x",
      clientSecret: "y",
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /wrangler secret put TOKEN_ENCRYPTION_KEY/,
    );
    expect(await storedValue("google")).toBeNull();
    expect((await list(apiKey)).encryptionKeyConfigured).toBe(false);
  });

  it("treats a secret sealed under a different key as not configured", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await put(apiKey, "google", { clientId: "db-client", clientSecret: "s" });
    // 32 different bytes: as if TOKEN_ENCRYPTION_KEY had been rotated.
    unsetBinding("TOKEN_ENCRYPTION_KEY");
    bindings.TOKEN_ENCRYPTION_KEY = btoa("z".repeat(32));

    // Not silently falling back to the env vars either: re-entering the
    // secret is the fix, and the UI has to say so.
    expect(await loadProviderConfig(getDb(), env, "google")).toBeNull();
    const google = (await list(apiKey)).providers.find(
      (p) => p.provider === "google",
    )!;
    expect(google).toMatchObject({ configured: false, source: "database" });
  });

  it("falls back to env vars once the stored settings are removed", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await put(apiKey, "google", { clientId: "db-client", clientSecret: "s" });

    const res = await authFetch("/api/admin/integrations/google", {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      source: "env",
      clientId: "test-google-client-id",
    });
  });

  it("is configurable from the UI alone, with no Google env vars at all", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    unsetBinding("GOOGLE_OAUTH_CLIENT_ID");
    unsetBinding("GOOGLE_OAUTH_CLIENT_SECRET");

    const before = await authFetch("/api/admin/gmail/connect", { apiKey });
    expect(before.status).toBe(503);

    await put(apiKey, "google", {
      clientId: "ui-client.apps.googleusercontent.com",
      clientSecret: "ui-secret",
    });
    const after = await authFetch("/api/admin/gmail/connect", { apiKey });
    expect(after.status).toBe(200);
    const { authUrl } = (await after.json()) as { authUrl: string };
    expect(new URL(authUrl).searchParams.get("client_id")).toBe(
      "ui-client.apps.googleusercontent.com",
    );
  });

  it("is admin-only", async () => {
    const { apiKey } = await createTestUser({ role: "member" });
    const res = await authFetch("/api/admin/integrations", { apiKey });
    expect(res.status).toBe(403);
    const write = await put(apiKey, "google", {
      clientId: "x",
      clientSecret: "y",
    });
    expect(write.status).toBe(403);
  });
});
