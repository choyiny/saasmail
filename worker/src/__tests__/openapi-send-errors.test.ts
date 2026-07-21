import { describe, it, expect, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations } from "./helpers";

describe("OpenAPI send path errors", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("GET /doc documents send, reply, and template-send error responses", async () => {
    const res = await exports.default.fetch("http://localhost/doc");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        { post?: { responses?: Record<string, { description?: string }> } }
      >;
    };

    const send = doc.paths["/api/send"]?.post?.responses;
    expect(send?.["201"]).toBeDefined();
    expect(send?.["400"]?.description).toMatch(/payload/i);
    expect(send?.["403"]?.description).toMatch(/inbox/i);
    expect(send?.["413"]?.description).toMatch(/attachment/i);

    const reply = doc.paths["/api/send/reply/{emailId}"]?.post?.responses;
    expect(reply?.["201"]).toBeDefined();
    expect(reply?.["400"]).toBeDefined();
    expect(reply?.["403"]).toBeDefined();
    expect(reply?.["404"]?.description).toMatch(/not found/i);
    expect(reply?.["413"]).toBeDefined();

    const templateSend =
      doc.paths["/api/email-templates/{slug}/send"]?.post?.responses;
    expect(templateSend?.["201"]).toBeDefined();
    expect(templateSend?.["400"]?.description).toMatch(/variables/i);
    expect(templateSend?.["403"]).toBeDefined();
    expect(templateSend?.["404"]?.description).toMatch(/not found/i);
  });
});
