import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import app from "../index";
import { applyMigrations, authFetch } from "./helpers";

const WELL_KNOWN = "/.well-known/saasmail";

// The test env bindings are fixed by the pool, so vars are overridden by
// handing the app a copy of the env.
async function withVars(vars: Record<string, string>) {
  return app.fetch(
    new Request(`http://localhost${WELL_KNOWN}`),
    { ...env, ...vars } as unknown as CloudflareBindings,
    {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
}

describe("GET /.well-known/saasmail", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM install_state");
  });

  it("reports nulls on an instance the installer never touched", async () => {
    const res = await authFetch(WELL_KNOWN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      installationId: null,
      version: null,
      schemaDigest: null,
    });
  });

  it("reports the installation from its var and row", async () => {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO install_state (installation_id, ownership_nonce, version, manifest_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "saasmail-1a2b3c4d5e6f",
        "n",
        "abc1234",
        '{"schemaDigest":"d1g"}',
        Date.now(),
      )
      .run();
    const res = await withVars({
      SAASMAIL_INSTALLATION:
        '{"installationId":"saasmail-1a2b3c4d5e6f","ownershipNonce":"n"}',
      SAASMAIL_VERSION: "abc1234",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      installationId: "saasmail-1a2b3c4d5e6f",
      version: "abc1234",
      schemaDigest: "d1g",
    });
    expect(JSON.stringify(body)).not.toContain("ownershipNonce");
  });

  it("ignores a malformed SAASMAIL_INSTALLATION", async () => {
    const res = await withVars({ SAASMAIL_INSTALLATION: "not json" });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { installationId: unknown }).installationId,
    ).toBeNull();
  });
});
