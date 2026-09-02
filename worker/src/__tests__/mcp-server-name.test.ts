import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { appSettings } from "../db/app-settings.schema";
import {
  ALL_SCOPES,
  type Credentials,
  createUserWithPassword,
  getAccessToken,
  mcpRpc,
  readRpc,
  req,
} from "./mcp-helpers";

const ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

async function setBrandName(value: string) {
  await getDb()
    .insert(appSettings)
    .values({
      key: "brand_name",
      value,
      updatedAt: Math.floor(Date.now() / 1000),
    });
}

async function initialize(accessToken: string) {
  const res = await mcpRpc(accessToken, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  expect(res.status, `initialize -> HTTP ${res.status}`).toBe(200);
  const body = await readRpc(res);
  expect(
    body.result?.serverInfo,
    `initialize returned no serverInfo: ${JSON.stringify(body)}`,
  ).toBeTruthy();
  return body.result.serverInfo as {
    name: string;
    title?: string;
    version: string;
  };
}

/**
 * Every deployment used to advertise the hardcoded name "saasmail", so an
 * operator connecting two instances to the same client got two servers it
 * could not tell apart. The instance's `brand_name` setting names it instead.
 */
describe("MCP server identity", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
  });

  it("reports the configured brand name as both name and title", async () => {
    await setBrandName("Acme Mail");
    const token = await getAccessToken(ADMIN, ALL_SCOPES);

    const serverInfo = await initialize(token);
    expect(serverInfo.name).toBe("Acme Mail");
    // Spec-compliant clients display `title`; older ones fall back to `name`.
    expect(serverInfo.title).toBe("Acme Mail");
  });

  it("falls back to saasmail when no brand name is set", async () => {
    const token = await getAccessToken(ADMIN, ALL_SCOPES);

    const serverInfo = await initialize(token);
    expect(serverInfo.name).toBe("saasmail");
  });

  it("publishes the brand name as RFC 9728 resource_name", async () => {
    await setBrandName("Acme Mail");

    const res = await req("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { resource_name: string };
    expect(meta.resource_name).toBe("Acme Mail");
  });

  it("defaults resource_name when no brand name is set", async () => {
    const res = await req("/.well-known/oauth-protected-resource/mcp");
    const meta = (await res.json()) as { resource_name: string };
    expect(meta.resource_name).toBe("saasmail");
  });
});
