import { describe, it, expect } from "vitest";
import { parse } from "../lib/interpolate";

describe("parse", () => {
  it("nests section children under the section node", () => {
    expect(parse("a{{#items}}b{{/items}}c")).toEqual([
      { kind: "text", value: "a" },
      {
        kind: "section",
        name: "items",
        inverted: false,
        optional: false,
        children: [{ kind: "text", value: "b" }],
      },
      { kind: "text", value: "c" },
    ]);
  });

  it("nests sections inside sections", () => {
    const ast = parse("{{#a}}{{#b}}x{{/b}}{{/a}}");
    expect(ast).toHaveLength(1);
    const outer = ast[0];
    if (outer.kind !== "section") throw new Error("expected section");
    expect(outer.name).toBe("a");
    expect(outer.children).toHaveLength(1);
    const inner = outer.children[0];
    if (inner.kind !== "section") throw new Error("expected nested section");
    expect(inner.name).toBe("b");
  });

  it("throws when a section is never closed", () => {
    expect(() => parse("{{#a}}x")).toThrow(/unclosed section .*\{\{#a\}\}/i);
  });

  it("throws when a close tag does not match the open tag", () => {
    expect(() => parse("{{#a}}x{{/b}}")).toThrow(
      /\{\{\/b\}\} does not match .*\{\{#a\}\}/i,
    );
  });

  it("throws on a close tag with no open section", () => {
    expect(() => parse("x{{/a}}")).toThrow(/unexpected \{\{\/a\}\}/i);
  });
});
