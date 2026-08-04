import { describe, it, expect } from "vitest";
import { escapeHtml, tokenize } from "../lib/interpolate";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("escapes ampersands exactly once", () => {
    expect(escapeHtml("a &amp; b")).toBe("a &amp;amp; b");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("Ada Lovelace")).toBe("Ada Lovelace");
  });
});

describe("tokenize", () => {
  it("splits text and a simple variable", () => {
    expect(tokenize("Hi {{name}}!")).toEqual([
      { kind: "text", value: "Hi " },
      {
        kind: "var",
        name: "name",
        raw: false,
        optional: false,
        filters: [],
        source: "{{name}}",
      },
      { kind: "text", value: "!" },
    ]);
  });

  it("recognises a triple-brace raw tag", () => {
    expect(tokenize("{{{block}}}")).toEqual([
      {
        kind: "var",
        name: "block",
        raw: true,
        optional: false,
        filters: [],
        source: "{{{block}}}",
      },
    ]);
  });

  it("recognises optional and filtered tags, and both together", () => {
    expect(tokenize("{{a?}}{{b|nl2br}}{{{c?|nl2br}}}")).toEqual([
      {
        kind: "var",
        name: "a",
        raw: false,
        optional: true,
        filters: [],
        source: "{{a?}}",
      },
      {
        kind: "var",
        name: "b",
        raw: false,
        optional: false,
        filters: ["nl2br"],
        source: "{{b|nl2br}}",
      },
      {
        kind: "var",
        name: "c",
        raw: true,
        optional: true,
        filters: ["nl2br"],
        source: "{{{c?|nl2br}}}",
      },
    ]);
  });

  it("recognises section open, inverted open, optional section, and close", () => {
    expect(tokenize("{{#a}}{{^b}}{{#c?}}{{/a}}")).toEqual([
      {
        kind: "open",
        name: "a",
        inverted: false,
        optional: false,
        source: "{{#a}}",
      },
      {
        kind: "open",
        name: "b",
        inverted: true,
        optional: false,
        source: "{{^b}}",
      },
      {
        kind: "open",
        name: "c",
        inverted: false,
        optional: true,
        source: "{{#c?}}",
      },
      { kind: "close", name: "a", source: "{{/a}}" },
    ]);
  });

  it("recognises the dot tag for array-of-string iteration", () => {
    expect(tokenize("{{.}}")).toEqual([
      {
        kind: "var",
        name: ".",
        raw: false,
        optional: false,
        filters: [],
        source: "{{.}}",
      },
    ]);
  });

  it("leaves a run with no valid name as literal text", () => {
    // Preserves the existing "{{not-a-var}} stays verbatim" behavior: none of
    // these contain a `[\w.]+` name for either brace form to match against,
    // so no tag is found anywhere and the whole input is literal text.
    for (const input of ["{{not-a-var}}", "{{}}", "{{ }}"]) {
      const tokens = tokenize(input);
      expect(
        tokens.map((t) => (t.kind === "text" ? t.value : "")).join(""),
      ).toContain("{{");
    }
  });

  it("resolves an incomplete raw brace against a real tag, leaving the odd brace as text", () => {
    // "{{{name}}" is one closing brace short of a raw tag. The raw and plain
    // forms are matched as fully separate alternatives (see the TAG comment
    // in interpolate.ts), so this is not read as a malformed raw tag; it is
    // read as a lone literal "{" immediately followed by the plain tag
    // "{{name}}". Symmetrically, "{{name}}}" is a plain tag followed by one
    // leftover literal "}". This is the same brace-run divergence from the
    // legacy flat regex documented and asserted in interpolate-compat.test.ts.
    expect(tokenize("{{{name}}")).toEqual([
      { kind: "text", value: "{" },
      {
        kind: "var",
        name: "name",
        raw: false,
        optional: false,
        filters: [],
        source: "{{name}}",
      },
    ]);
    expect(tokenize("{{name}}}")).toEqual([
      {
        kind: "var",
        name: "name",
        raw: false,
        optional: false,
        filters: [],
        source: "{{name}}",
      },
      { kind: "text", value: "}" },
    ]);
  });

  it("rejects an unknown filter", () => {
    expect(() => tokenize("{{a|shout}}")).toThrow(/unknown filter "shout"/i);
  });
});
