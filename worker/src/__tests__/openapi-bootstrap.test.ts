import { describe, it, expect, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations } from "./helpers";

describe("OpenAPI bootstrap routes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("GET /doc documents /api/health and /api/config without security", async () => {
    const res = await exports.default.fetch("http://localhost/doc");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        {
          get?: {
            tags?: string[];
            security?: unknown;
            responses?: Record<string, unknown>;
          };
        }
      >;
    };

    const health = doc.paths["/api/health"]?.get;
    expect(health?.tags).toContain("Bootstrap");
    expect(health?.security).toBeUndefined();
    expect(health?.responses?.["200"]).toBeDefined();

    const config = doc.paths["/api/config"]?.get;
    expect(config?.tags).toContain("Bootstrap");
    expect(config?.security).toBeUndefined();
    expect(config?.responses?.["200"]).toBeDefined();
  });
});
