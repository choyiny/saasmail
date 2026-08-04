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

  it("registers the recursive TemplateValue schema as a bounded $ref, not inline recursion", async () => {
    const res = await exports.default.fetch("http://localhost/doc");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      components: { schemas?: Record<string, unknown> };
      paths: Record<
        string,
        {
          post?: {
            requestBody?: {
              content?: Record<string, { schema?: unknown }>;
            };
          };
        }
      >;
    };

    // The lazy schema is registered under its own component name — proof
    // the .openapi("TemplateValue") ref id took effect instead of the
    // generator inlining (or infinitely recursing through) the union.
    const templateValue = doc.components.schemas?.TemplateValue as
      | { anyOf?: Array<Record<string, unknown>> }
      | undefined;
    expect(templateValue).toBeDefined();
    expect(Array.isArray(templateValue?.anyOf)).toBe(true);
    // Serializing it must terminate — an unbounded/circular structure here
    // would throw on JSON.stringify (or never return) instead of failing
    // a plain assertion.
    const serialized = JSON.stringify(templateValue);
    expect(serialized).toContain("#/components/schemas/TemplateValue");

    // The send route's `variables` field must compose with that same ref
    // rather than falling back to an untyped object.
    const sendSchema = doc.paths["/api/email-templates/{slug}/send"]?.post
      ?.requestBody?.content?.["application/json"]?.schema as
      | {
          properties?: {
            variables?: { additionalProperties?: { $ref?: string } };
          };
        }
      | undefined;
    expect(sendSchema?.properties?.variables?.additionalProperties?.$ref).toBe(
      "#/components/schemas/TemplateValue",
    );
  });
});
