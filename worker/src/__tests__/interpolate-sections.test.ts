import { describe, it, expect } from "vitest";
import { interpolate } from "../lib/interpolate";

describe("interpolate — conditional sections", () => {
  it("renders the body when the value is truthy", () => {
    expect(interpolate("{{#on}}yes{{/on}}", { on: true })).toBe("yes");
  });

  it.each([
    ["false", false],
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["zero", 0],
    ["empty array", [] as unknown[]],
  ])("skips the body when the value is %s", (_label, value) => {
    expect(interpolate("{{#on}}yes{{/on}}", { on: value as never })).toBe("");
  });

  it("skips the body when the value is absent entirely", () => {
    expect(interpolate("{{#on}}yes{{/on}}", {})).toBe("");
  });
});

describe("interpolate — inverted sections", () => {
  it("renders when the value is falsy or absent", () => {
    expect(interpolate("{{^f}}none{{/f}}", { f: [] })).toBe("none");
    expect(interpolate("{{^f}}none{{/f}}", {})).toBe("none");
  });

  it("skips when the value is truthy", () => {
    expect(interpolate("{{^f}}none{{/f}}", { f: ["a"] })).toBe("");
  });
});

describe("interpolate — iteration", () => {
  it("renders once per item for an array of objects", () => {
    expect(
      interpolate("{{#items}}<li>{{label}}</li>{{/items}}", {
        items: [{ label: "one" }, { label: "two" }],
      }),
    ).toBe("<li>one</li><li>two</li>");
  });

  it("uses {{.}} for an array of strings", () => {
    expect(interpolate("{{#tags}}[{{.}}]{{/tags}}", { tags: ["a", "b"] })).toBe(
      "[a][b]",
    );
  });

  it("escapes item values", () => {
    expect(
      interpolate("{{#items}}{{label}}{{/items}}", {
        items: [{ label: "<b>x</b>" }],
      }),
    ).toBe("&lt;b&gt;x&lt;/b&gt;");
  });

  it("falls through to the outer scope for names the item lacks", () => {
    expect(
      interpolate("{{#items}}{{currency}}{{price}} {{/items}}", {
        currency: "$",
        items: [{ price: "10" }, { price: "20" }],
      }),
    ).toBe("$10 $20 ");
  });

  it("lets an item shadow an outer name", () => {
    expect(
      interpolate("{{#items}}{{name}}{{/items}}", {
        name: "outer",
        items: [{ name: "inner" }],
      }),
    ).toBe("inner");
  });

  it("nests sections", () => {
    expect(
      interpolate(
        "{{#orders}}{{id}}:{{#lines}}{{sku}},{{/lines}};{{/orders}}",
        {
          orders: [
            { id: "A", lines: [{ sku: "x" }, { sku: "y" }] },
            { id: "B", lines: [] },
          ],
        },
      ),
    ).toBe("A:x,y,;B:;");
  });

  it("pushes a plain object as scope without iterating", () => {
    expect(
      interpolate("{{#user}}{{name}}{{/user}}", { user: { name: "Ada" } }),
    ).toBe("Ada");
  });
});

describe("interpolate — sibling and nested inverted sections", () => {
  it("renders sibling sections at the same nesting level independently", () => {
    expect(
      interpolate("{{#a}}{{#b}}x{{/b}}{{#c}}y{{/c}}{{/a}}", {
        a: true,
        b: true,
        c: true,
      }),
    ).toBe("xy");
  });

  it("skips a sibling section whose own value is falsy while its neighbor still renders", () => {
    expect(
      interpolate("{{#a}}{{#b}}x{{/b}}{{#c}}y{{/c}}{{/a}}", {
        a: true,
        b: false,
        c: true,
      }),
    ).toBe("y");
  });

  it("renders an inverted section nested inside a regular section, per item", () => {
    // Asserted per-item (not on the concatenation of a multi-item array) so
    // that a flipped inverted-condition bug can't cancel out: with items
    // [{tags:[]}, {tags:["x"]}] concatenated into one string, a correctly
    // inverted implementation and one with `^` treated as `#` both produce
    // "none" overall (just from different items), so a single combined
    // assertion would pass either way.
    expect(
      interpolate("{{#items}}{{^tags}}none{{/tags}}{{/items}}", {
        items: [{ tags: [] }],
      }),
    ).toBe("none");
    expect(
      interpolate("{{#items}}{{^tags}}none{{/tags}}{{/items}}", {
        items: [{ tags: ["x"] }],
      }),
    ).toBe("");
  });
});

describe("interpolate — context stack isolation", () => {
  it("does not leak a field from one item's scope into the next item's lookup", () => {
    // If the renderer pushed each item onto a SHARED stack array without
    // popping between iterations, `lookup`'s innermost-first search would
    // still find `extra` from item A's leaked frame while rendering item B.
    // Item B has no `extra` of its own, so the correct result is that its
    // `{{extra}}` tag is unresolved and survives verbatim as source text.
    expect(
      interpolate("{{#items}}{{extra}}{{/items}}", {
        items: [{ extra: "leak" }, {}],
      }),
    ).toBe("leak{{extra}}");
  });
});

describe("interpolate — isTruthy edge cases", () => {
  it("treats an empty object as truthy and renders its section body once", () => {
    expect(interpolate("{{#obj}}yes{{/obj}}", { obj: {} })).toBe("yes");
  });
});
