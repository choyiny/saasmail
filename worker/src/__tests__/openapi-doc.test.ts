import { describe, it, expect, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations } from "./helpers";
import { BEARER_AUTH_SCHEME } from "../lib/openapi-auth";

describe("OpenAPI /doc", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("GET /doc is public and documents Bearer auth", async () => {
    const res = await exports.default.fetch("http://localhost/doc");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      info: { description?: string };
      components: { securitySchemes?: Record<string, unknown> };
      paths: Record<
        string,
        { post?: { security?: Array<Record<string, unknown>> } }
      >;
    };

    expect(doc.info.description).toContain("Authorization: Bearer sk_");
    expect(doc.info.description).toContain("PASSKEY_REQUIRED");
    expect(doc.components.securitySchemes?.[BEARER_AUTH_SCHEME]).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(doc.paths["/api/send"]?.post?.security).toEqual([
      { [BEARER_AUTH_SCHEME]: [] },
    ]);
  });
});
