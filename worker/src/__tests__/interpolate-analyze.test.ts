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

  it("does not leak names from a doubly-nested section into required/optional", () => {
    // Guards against collectInner's nested-section branch accidentally
    // recursing via walkTopLevel instead of into itself, which would only
    // leak names at depth >= 2 — a bug the single-nesting tests above would
    // not catch.
    const a = analyzeTemplate(
      "{{#orders}}{{id}}{{#lines}}{{sku}}{{/lines}}{{/orders}}",
    );
    expect(a.required).toEqual(["orders"]);
    expect(a.required).not.toContain("id");
    expect(a.required).not.toContain("sku");
    expect(a.required).not.toContain("lines");
    expect(a.optional).not.toContain("id");
    expect(a.optional).not.toContain("sku");
    expect(a.optional).not.toContain("lines");
  });

  it("resolves a name that is both required and optional in favor of required", () => {
    // Guards against the dedup loop running backwards (deleting from
    // `required` based on `optional` membership instead of the other way
    // around), which would silently make a required name optional.
    const a = analyzeTemplate("{{name}}{{name?}}");
    expect(a.required).toEqual(["name"]);
    expect(a.optional).toEqual([]);
  });

  it("resolves the same required/optional collision across two sources", () => {
    // The merge happens after both sources are walked, so this must hold
    // regardless of which source declares the name optional first.
    const a = analyzeTemplate("{{name?}}", "{{name}}");
    expect(a.required).toEqual(["name"]);
    expect(a.optional).toEqual([]);
  });

  it("merges duplicate section entries across sources by name", () => {
    const a = analyzeTemplate(
      "{{#items}}{{price}}{{/items}}",
      "{{#items}}{{qty}}{{/items}}",
    );
    expect(a.sections).toEqual([
      { name: "items", inverted: false, variables: ["price", "qty"] },
    ]);
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
