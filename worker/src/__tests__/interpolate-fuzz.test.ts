import { describe, it, expect } from "vitest";
import {
  analyzeTemplate,
  interpolate,
  MAX_SECTION_DEPTH,
  TemplateParseError,
} from "../lib/interpolate";

const CHUNKS = [
  "{{",
  "}}",
  "{{{",
  "}}}",
  "{{#a}}",
  "{{/a}}",
  "{{/b}}",
  "{{^a}}",
  "{{a}}",
  "{{a?}}",
  "{{a|nl2br}}",
  "{{.}}",
  "text",
  "<p>",
  "\n",
  "{",
  "}",
  "{{}}",
];

function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("interpolate — robustness", () => {
  it("never throws anything but TemplateParseError on arbitrary input", () => {
    const rand = makeRandom(7);
    for (let i = 0; i < 5000; i++) {
      const n = 1 + Math.floor(rand() * 10);
      const template = Array.from(
        { length: n },
        () => CHUNKS[Math.floor(rand() * CHUNKS.length)],
      ).join("");
      try {
        interpolate(template, { a: "x" });
      } catch (err) {
        expect(err).toBeInstanceOf(TemplateParseError);
      }
    }
  });

  it("renders sections nested to exactly the depth limit", () => {
    const template =
      "{{#a}}".repeat(MAX_SECTION_DEPTH) +
      "x" +
      "{{/a}}".repeat(MAX_SECTION_DEPTH);
    expect(interpolate(template, { a: true })).toBe("x");
  });

  it("rejects nesting past the limit with a parse error, not a RangeError", () => {
    // Rendering and analyzeTemplate's inner collection both recurse per level,
    // so unbounded depth would overflow the stack and escape as an unhandled
    // 500 (workerd's stack is smaller than Node's). The cap converts that into
    // a TemplateParseError, which every caller already handles as a 400.
    const depth = MAX_SECTION_DEPTH + 1;
    const template = "{{#a}}".repeat(depth) + "x" + "{{/a}}".repeat(depth);
    expect(() => interpolate(template, { a: true })).toThrow(
      TemplateParseError,
    );
    expect(() => interpolate(template, { a: true })).toThrow(
      /nested too deeply/i,
    );
  });

  it("caps analyzeTemplate the same way, since it recurses too", () => {
    const depth = MAX_SECTION_DEPTH + 1;
    const template = "{{#a}}".repeat(depth) + "{{x}}" + "{{/a}}".repeat(depth);
    expect(() => analyzeTemplate(template)).toThrow(TemplateParseError);
  });

  it("handles a very long template", () => {
    const template = "<p>{{name}}</p>".repeat(20000);
    expect(interpolate(template, { name: "Ada" })).toContain("<p>Ada</p>");
  });
});
