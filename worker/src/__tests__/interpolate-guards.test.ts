import { describe, it, expect } from "vitest";
import {
  interpolate,
  renderTemplate,
  TemplateParseError,
  TemplateRenderError,
  MAX_SECTION_RENDERS,
} from "../lib/interpolate";

/**
 * Two classes of silent failure that the section rewrite introduced, both
 * found in review of the stack. Neither is about parsing — a template can be
 * perfectly well-formed and still hit them — so they live apart from the
 * tokenizer/parser suites.
 */

describe("render work budget", () => {
  /**
   * Nesting a section inside itself is the pathological case: the inner
   * `{{#items}}` cannot resolve against the item frame, so `lookup` falls back
   * to the top-level array and iterates it again. Work grows as N^depth while
   * both the template and the payload stay tiny, so neither MAX_SECTION_DEPTH
   * (which bounds nesting) nor MAX_VARIABLE_DEPTH (which bounds the payload)
   * sees anything wrong.
   */
  it("rejects a self-nested section instead of expanding it exponentially", () => {
    const depth = 6;
    const body = "{{#items}}".repeat(depth) + "x" + "{{/items}}".repeat(depth);
    const items = Array.from({ length: 20 }, (_, i) => ({ i }));

    // 20^6 = 64,000,000 renders if unbounded.
    expect(() => interpolate(body, { items })).toThrow(TemplateRenderError);
  });

  it("names the budget in the error so the author can see what happened", () => {
    const body =
      "{{#items}}{{#items}}{{#items}}x{{/items}}{{/items}}{{/items}}";
    const items = Array.from({ length: 40 }, (_, i) => ({ i }));
    expect(() => interpolate(body, { items })).toThrow(
      new RegExp(String(MAX_SECTION_RENDERS)),
    );
  });

  it("is a TemplateParseError subclass, so every existing caller still catches it", () => {
    const body =
      "{{#items}}{{#items}}{{#items}}x{{/items}}{{/items}}{{/items}}";
    const items = Array.from({ length: 40 }, (_, i) => ({ i }));
    expect(() => interpolate(body, { items })).toThrow(TemplateParseError);
  });

  it("leaves ordinary templates well clear of the budget", () => {
    const body = "{{#rows}}<tr><td>{{label}}</td></tr>{{/rows}}";
    const rows = Array.from({ length: 500 }, (_, i) => ({ label: `r${i}` }));
    const out = interpolate(body, { rows });
    expect(out.match(/<tr>/g)).toHaveLength(500);
  });

  it("budgets the whole render, not each section separately", () => {
    // Many sibling sections, each individually small, summing past the cap.
    const one = "{{#rows}}x{{/rows}}";
    const rows = Array.from({ length: 1000 }, (_, i) => ({ i }));
    const body = one.repeat(MAX_SECTION_RENDERS / 1000 + 5);
    expect(() => interpolate(body, { rows })).toThrow(TemplateRenderError);
  });
});

describe("unresolved names in a section that pushes no scope", () => {
  /**
   * An inverted section never pushes a frame, and a truthy *scalar* section
   * renders its body against the unchanged stack. So a name inside either one
   * is an ordinary top-level lookup — not something that resolves per item —
   * and blanking it hides a caller error rather than tolerating a per-item gap.
   */
  it("reports a missing name inside an inverted section", () => {
    const result = renderTemplate(
      {
        subject: "s",
        bodyHtml:
          "{{^has_orders}}<p>Hi {{first_name}}, nothing yet.</p>{{/has_orders}}",
      },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingVariables).toContain("first_name");
  });

  it("reports a missing name inside a boolean-guarded section", () => {
    const result = renderTemplate(
      {
        subject: "Order {{order_id}}",
        bodyHtml:
          "{{#has_discount}}<p>Your code is {{discount_code}}!</p>{{/has_discount}}",
      },
      { order_id: "1", has_discount: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingVariables).toContain("discount_code");
  });

  it("still tolerates a per-item gap inside an iterating section", () => {
    // `note` is genuinely per-item here: some items have it, some do not.
    // That must keep rendering empty rather than failing the send.
    const result = renderTemplate(
      {
        subject: "s",
        bodyHtml: "{{#items}}<li>{{label}}{{note}}</li>{{/items}}",
      },
      { items: [{ label: "a", note: "!" }, { label: "b" }] },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bodyHtml).toBe("<li>a!</li><li>b</li>");
  });

  it("does not report a name the section body resolves from an outer scope", () => {
    const result = renderTemplate(
      {
        subject: "s",
        bodyHtml: "{{^empty}}<p>{{greeting}}</p>{{/empty}}",
      },
      { greeting: "Hi" },
    );
    expect(result.ok).toBe(true);
  });

  it("respects the optional marker inside a scope-less section", () => {
    const result = renderTemplate(
      { subject: "s", bodyHtml: "{{^empty}}<p>{{note?}}</p>{{/empty}}" },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bodyHtml).toBe("<p></p>");
  });

  it("keeps the sequence path lax — interpolate alone never throws for a missing name", () => {
    // sequence-processor renders with `interpolate` directly and has no
    // failure channel; it must keep its existing behavior.
    expect(() => interpolate("{{^x}}Hi {{name}}{{/x}}", {})).not.toThrow();
  });
});

describe("value shape", () => {
  /**
   * `variables` accepts any JSON value since the API widened, but a name used
   * in scalar position renders `""` for an object or array — the send succeeds
   * and the email is silently wrong. Analysis already knows which names are
   * only ever used as `{{name}}`.
   */
  it("rejects an object supplied for a scalar variable", () => {
    const result = renderTemplate(
      { subject: "Hi {{name}}", bodyHtml: "<p>{{name}}</p>" },
      { name: { first: "a" } },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an array supplied for a scalar variable", () => {
    const result = renderTemplate(
      { subject: "s", bodyHtml: "<p>{{tags}}</p>" },
      { tags: ["a", "b"] },
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a scalar for a name used as a section", () => {
    // A boolean conditional section is a documented, supported pattern.
    const result = renderTemplate(
      { subject: "s", bodyHtml: "{{#isTrial}}<p>Trial</p>{{/isTrial}}" },
      { isTrial: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bodyHtml).toBe("<p>Trial</p>");
  });

  it("catches a scalar sent where a section body needs item fields", () => {
    // `{"items": "yes"}` used to render `<li></li>` and return 201.
    const result = renderTemplate(
      { subject: "s", bodyHtml: "{{#items}}<li>{{label}}</li>{{/items}}" },
      { items: "yes" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingVariables).toContain("label");
  });

  it("leaves numbers and booleans alone in scalar position", () => {
    const result = renderTemplate(
      { subject: "s", bodyHtml: "<p>{{count}}{{flag}}</p>" },
      { count: 0, flag: false },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bodyHtml).toBe("<p>0false</p>");
  });
});
