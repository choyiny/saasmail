/**
 * `GET /api/config` is how a client that was not deployed alongside the worker
 * finds out what this build can do. The web UI ships from the same commit and
 * never needs to ask; a third-party or native client talks to whatever version
 * an operator is running, and without this it can only discover a missing
 * capability by attempting it and guessing at the failure.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb } from "./helpers";
import { exports } from "cloudflare:workers";

function getConfig() {
  return exports.default.fetch("http://localhost/api/config");
}

describe("GET /api/config", () => {
  beforeAll(applyMigrations);
  beforeEach(cleanDb);

  it("is reachable without authentication", async () => {
    const res = await getConfig();
    expect(res.status).toBe(200);
  });

  it("still reports the fields the web UI already reads", async () => {
    const body = (await (await getConfig()).json()) as Record<string, unknown>;
    expect(body).toHaveProperty("passkeyRequired");
    expect(body).toHaveProperty("brandName");
  });

  it("advertises an integer api version", async () => {
    const body = (await (await getConfig()).json()) as { apiVersion: number };
    expect(Number.isInteger(body.apiVersion)).toBe(true);
    expect(body.apiVersion).toBeGreaterThanOrEqual(1);
  });

  it("advertises the capabilities a non-browser client branches on", async () => {
    const body = (await (await getConfig()).json()) as {
      capabilities: Record<string, boolean>;
    };
    // A client checks these before registering, so a false must be legible as
    // "this server is too old" rather than as an absent key it might misread.
    expect(body.capabilities).toEqual({
      oauthApi: true,
      oauthStream: true,
    });
  });

  it("reports capabilities as booleans, never as undefined", async () => {
    const body = (await (await getConfig()).json()) as {
      capabilities: Record<string, unknown>;
    };
    for (const [key, value] of Object.entries(body.capabilities)) {
      expect(typeof value, `${key} should be a boolean`).toBe("boolean");
    }
  });
});
