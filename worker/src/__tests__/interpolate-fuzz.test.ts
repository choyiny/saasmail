import { describe, it, expect } from "vitest";
import { interpolate, TemplateParseError } from "../lib/interpolate";

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

  it("handles deeply nested sections without blowing the stack", () => {
    const depth = 200;
    const template = "{{#a}}".repeat(depth) + "x" + "{{/a}}".repeat(depth);
    expect(interpolate(template, { a: true })).toBe("x");
  });

  it("handles a very long template", () => {
    const template = "<p>{{name}}</p>".repeat(20000);
    expect(interpolate(template, { name: "Ada" })).toContain("<p>Ada</p>");
  });
});
