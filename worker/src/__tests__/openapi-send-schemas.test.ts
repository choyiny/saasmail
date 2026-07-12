import { describe, it, expect, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations } from "./helpers";

describe("OpenAPI send schemas", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("GET /doc registers SendEmailSchema, CcEntry, and ReplyEmailSchema", async () => {
    const res = await exports.default.fetch("http://localhost/doc");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      components: {
        schemas?: Record<
          string,
          { properties?: Record<string, unknown>; type?: string }
        >;
      };
    };

    const schemas = doc.components.schemas ?? {};
    expect(Object.keys(schemas).sort()).toEqual(
      ["CcEntry", "ReplyEmailSchema", "SendEmailSchema"].sort(),
    );

    const send = schemas.SendEmailSchema;
    expect(send?.properties).toMatchObject({
      to: expect.any(Object),
      fromAddress: expect.any(Object),
      subject: expect.any(Object),
      bodyHtml: expect.any(Object),
      transactional: expect.any(Object),
    });

    const reply = schemas.ReplyEmailSchema;
    expect(reply?.properties).toMatchObject({
      fromAddress: expect.any(Object),
      bodyHtml: expect.any(Object),
      templateSlug: expect.any(Object),
    });

    const cc = schemas.CcEntry;
    expect(cc?.properties).toMatchObject({
      email: expect.any(Object),
    });
  });
});
