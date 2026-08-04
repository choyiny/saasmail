import { describe, it, expect } from "vitest";
import {
  analyzeTemplate,
  extractVariables,
  renderTemplate,
} from "../lib/interpolate";

describe("analyzeTemplate — the validation split", () => {
  it("does NOT mark a section-body variable as required", () => {
    // The regression that would break every existing send if inverted.
    const a = analyzeTemplate("{{#items}}{{price}}{{/items}}");
    expect(a.required).toEqual(["items"]);
    expect(a.required).not.toContain("price");
  });

  it("reports section-body variables under sections", () => {
    const a = analyzeTemplate("{{#items}}{{price}}{{qty}}{{/items}}");
    expect(a.sections).toEqual([
      { name: "items", inverted: false, variables: ["price", "qty"] },
    ]);
  });

  it("marks a regular section required and an inverted section optional", () => {
    const a = analyzeTemplate("{{#a}}x{{/a}}{{^b}}y{{/b}}");
    expect(a.required).toEqual(["a"]);
    expect(a.optional).toEqual(["b"]);
  });

  it("treats {{#a?}} as optional", () => {
    const a = analyzeTemplate("{{#a?}}x{{/a}}");
    expect(a.required).toEqual([]);
    expect(a.optional).toEqual(["a"]);
  });

  it("separates optional from required top-level variables", () => {
    const a = analyzeTemplate("{{name}}{{nickname?}}");
    expect(a.required).toEqual(["name"]);
    expect(a.optional).toEqual(["nickname"]);
  });

  it("ignores the dot tag", () => {
    const a = analyzeTemplate("{{#tags}}{{.}}{{/tags}}");
    expect(a.required).toEqual(["tags"]);
    expect(a.sections[0].variables).toEqual([]);
  });

  it("merges across multiple sources and de-duplicates", () => {
    const a = analyzeTemplate("Hi {{name}}", "<p>{{name}} {{email}}</p>");
    expect(a.required).toEqual(["name", "email"]);
  });
});

describe("extractVariables", () => {
  it("returns the required set, preserving the pre-rewrite contract", () => {
    expect(extractVariables("Hi {{name}}, {{email}}")).toEqual([
      "name",
      "email",
    ]);
  });
});

describe("renderTemplate", () => {
  it("succeeds when only the section name is supplied", () => {
    const r = renderTemplate(
      { subject: "Digest", bodyHtml: "{{#items}}{{price}}{{/items}}" },
      { items: [{ price: "10" }] },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bodyHtml).toBe("10");
  });

  it("still fails a send when a required top-level variable is missing", () => {
    const r = renderTemplate({ subject: "Hi {{name}}", bodyHtml: "x" }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingVariables).toEqual(["name"]);
  });

  it("does not require an optional variable", () => {
    const r = renderTemplate({ subject: "Hi", bodyHtml: "{{promo?}}" }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bodyHtml).toBe("");
  });

  it("reports a parse error instead of throwing", () => {
    const r = renderTemplate({ subject: "x", bodyHtml: "{{#a}}oops" }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.parseError).toMatch(/unclosed section/i);
  });
});
