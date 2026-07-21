import { describe, it, expect, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations } from "./helpers";

describe("OpenAPI sequence enrollment", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("GET /doc documents EnrollmentSchema and enroll errors", async () => {
    const res = await exports.default.fetch("http://localhost/doc");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        {
          post?: { responses?: Record<string, { description?: string }> };
          delete?: { responses?: Record<string, { description?: string }> };
        }
      >;
      components?: {
        schemas?: Record<string, { properties?: Record<string, unknown> }>;
      };
    };

    const enroll = doc.paths["/api/sequences/{id}/enroll"]?.post?.responses;
    expect(enroll?.["201"]).toBeDefined();
    expect(enroll?.["400"]?.description).toContain("active sequence");
    expect(enroll?.["404"]?.description).toContain("not found");

    const del = doc.paths["/api/sequences/{id}"]?.delete?.responses;
    expect(del?.["400"]?.description).toContain("active enrollments");

    const enrollBody =
      doc.paths["/api/sequences/{id}/enroll"]?.post?.responses?.["201"]
        ?.content?.["application/json"]?.schema;
    const enrollment = (
      enrollBody as {
        properties?: {
          enrollment?: { properties?: Record<string, unknown> };
        };
      }
    )?.properties?.enrollment?.properties;
    expect(enrollment).toMatchObject({
      fromAddress: expect.any(Object),
      variables: expect.any(Object),
    });
  });
});
