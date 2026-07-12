import { describe, it, expect, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations } from "./helpers";

function emailItemSchema(doc: {
  paths: Record<
    string,
    {
      get?: {
        responses?: Record<
          string,
          { content?: { "application/json"?: { schema?: unknown } } }
        >;
      };
    }
  >;
}) {
  const byPerson =
    doc.paths["/api/emails/by-person/{personId}"]?.get?.responses?.["200"]
      ?.content?.["application/json"]?.schema;
  const byPersonProps = (
    byPerson as { properties?: { emails?: { items?: unknown } } }
  )?.properties?.emails?.items;
  return byPersonProps as { properties?: Record<string, unknown> } | undefined;
}

describe("OpenAPI EmailSchema", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("GET /doc documents attachments on email responses", async () => {
    const res = await exports.default.fetch("http://localhost/doc");
    expect(res.status).toBe(200);
    const doc = await res.json();

    const emailItem = emailItemSchema(doc);
    expect(emailItem?.properties).toMatchObject({
      attachments: expect.any(Object),
      attachmentCount: expect.any(Object),
      replyTo: expect.any(Object),
    });

    const attachments = emailItem?.properties?.attachments as {
      type?: string;
      items?: { properties?: Record<string, unknown> };
    };
    expect(attachments?.type).toBe("array");
    expect(attachments?.items?.properties).toMatchObject({
      id: expect.any(Object),
      filename: expect.any(Object),
      contentType: expect.any(Object),
      size: expect.any(Object),
    });

    const replyTo = emailItem?.properties?.replyTo as { description?: string };
    expect(replyTo?.description).toContain("GET /api/emails/{id}");
  });
});
