import { describe, it, expect, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations } from "./helpers";

describe("OpenAPI send schemas", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("GET /doc registers SendEmailSchema, CcEntry, ReplyEmailSchema, and TemplateValue", async () => {
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
    // `TemplateValue` is the recursive schema for template variable values.
    // It has to be a named component rather than an inline one — a self
    // referencing `z.lazy` union can only be expressed via `$ref`, so
    // inlining it would recurse forever when the document is generated.
    expect(Object.keys(schemas).sort()).toEqual(
      [
        "CcEntry",
        "Inbox",
        "ReplyEmailSchema",
        "SendEmailSchema",
        "TemplateValue",
      ].sort(),
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
