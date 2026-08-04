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

describe("interpolate — plain-text mode ({ escape: false })", () => {
  it("emits HTML-significant characters literally", () => {
    expect(
      interpolate(
        "Hi {{v}}",
        { v: `O'Brien & Sons <VIP> "Ltd"` },
        {
          escape: false,
        },
      ),
    ).toBe(`Hi O'Brien & Sons <VIP> "Ltd"`);
  });

  it.each([
    ["&", "&"],
    ["'", "'"],
    ['"', '"'],
    ["<", "<"],
    [">", ">"],
  ])("passes %s through unchanged", (value) => {
    expect(interpolate("{{v}}", { v: value }, { escape: false })).toBe(value);
  });

  it("still escapes the same values when escaping is on (the HTML body path)", () => {
    expect(interpolate("{{v}}", { v: `&'"<>` })).toBe(
      "&amp;&#39;&quot;&lt;&gt;",
    );
  });

  it("treats a raw tag the same as a plain one", () => {
    expect(interpolate("{{{v}}}", { v: "<b>x</b>" }, { escape: false })).toBe(
      "<b>x</b>",
    );
  });

  it("skips nl2br rather than injecting a literal <br> into plain text", () => {
    // nl2br's whole purpose is producing HTML. In a Subject header there is no
    // HTML to produce, so it is a no-op and the value's newlines survive
    // untouched — a visible "<br>" in a subject line would be worse.
    expect(interpolate("{{v|nl2br}}", { v: "a\nb" }, { escape: false })).toBe(
      "a\nb",
    );
    expect(interpolate("{{v|nl2br}}", { v: "a\nb" })).toBe("a<br>b");
  });

  it("defaults to escaping when no options are passed", () => {
    expect(interpolate("{{v}}", { v: "<b>" })).toBe("&lt;b&gt;");
    expect(interpolate("{{v}}", { v: "<b>" }, {})).toBe("&lt;b&gt;");
  });
});

describe("interpolate — inherited object members are not variables", () => {
  it.each([
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ])("does not resolve %s from the prototype chain", (name) => {
    // `name in frame` would find these and render e.g. the source of
    // Object's constructor into an email.
    expect(interpolate(`{{${name}}}`, {})).toBe(`{{${name}}}`);
  });

  it("does not resolve an inherited member from a section item either", () => {
    // Section frames come straight from caller-supplied JSON.
    expect(
      interpolate("{{#items}}{{toString}}{{/items}}", { items: [{}] }),
    ).toBe("");
  });

  it("still resolves an own property that shadows a prototype member", () => {
    expect(interpolate("{{toString}}", { toString: "mine" })).toBe("mine");
  });
});

describe("interpolate — tag names match the legacy grammar exactly", () => {
  it.each(["{{ spaced }}", "{{ name }}", "{{example.com}}", "{{user.name}}"])(
    "leaves %s as literal text",
    (template) => {
      expect(interpolate(template, { spaced: "S", name: "N" })).toBe(template);
    },
  );
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
