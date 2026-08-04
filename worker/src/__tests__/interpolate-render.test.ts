import { describe, it, expect } from "vitest";
import { interpolate } from "../lib/interpolate";

describe("interpolate — escaping", () => {
  it("escapes markup in a substituted value", () => {
    expect(
      interpolate("<p>{{msg}}</p>", { msg: `<a href="http://evil">click</a>` }),
    ).toBe("<p>&lt;a href=&quot;http://evil&quot;&gt;click&lt;/a&gt;</p>");
  });

  it("escapes a script tag", () => {
    expect(interpolate("{{v}}", { v: "<script>alert(1)</script>" })).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes a single-quoted attribute breakout", () => {
    expect(interpolate("<img alt='{{v}}'>", { v: "' onerror='alert(1)" })).toBe(
      "<img alt='&#39; onerror=&#39;alert(1)'>",
    );
  });

  it("leaves the template's own text unescaped", () => {
    expect(interpolate("<p>It's {{v}}</p>", { v: "fine" })).toBe(
      "<p>It's fine</p>",
    );
  });

  it("passes a triple-brace value through unescaped", () => {
    expect(interpolate("{{{v}}}", { v: "<b>bold</b>" })).toBe("<b>bold</b>");
  });
});

describe("interpolate — optional variables", () => {
  it("renders an optional missing variable as empty", () => {
    expect(interpolate("a{{v?}}b", {})).toBe("ab");
  });

  it("still leaves a required missing variable verbatim", () => {
    expect(interpolate("a{{v}}b", {})).toBe("a{{v}}b");
  });
});

describe("interpolate — nl2br filter", () => {
  it("converts newlines after escaping, not before", () => {
    expect(interpolate("{{v|nl2br}}", { v: "line one\n<b>two</b>" })).toBe(
      "line one<br>&lt;b&gt;two&lt;/b&gt;",
    );
  });

  it("handles CRLF and bare CR", () => {
    expect(interpolate("{{v|nl2br}}", { v: "a\r\nb\rc" })).toBe("a<br>b<br>c");
  });

  it("composes with raw and optional", () => {
    expect(interpolate("{{{v?|nl2br}}}", { v: "<b>a</b>\nb" })).toBe(
      "<b>a</b><br>b",
    );
    expect(interpolate("{{{v?|nl2br}}}", {})).toBe("");
  });
});

describe("interpolate — non-string values", () => {
  it("stringifies numbers and booleans", () => {
    expect(interpolate("{{a}} {{b}}", { a: 42, b: true })).toBe("42 true");
  });

  it("renders null and undefined as empty", () => {
    expect(interpolate("[{{a}}][{{b}}]", { a: null, b: undefined })).toBe(
      "[][]",
    );
  });
});
