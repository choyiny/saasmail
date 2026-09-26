import { describe, it, expect } from "vitest";
import { sanitizeInlineHtml } from "../lib/blocks/sanitize";

/**
 * The sanitizer is the security boundary for block documents: its output is
 * emitted raw into compiled campaign HTML, frozen into a snapshot, and mailed
 * to every subscriber. It is an allowlist that *re-emits* rather than patches,
 * so the property under test throughout is "nothing from the input reaches the
 * output verbatim" — a construct the scanner misreads must become escaped text,
 * never a tag.
 */

describe("allowlisted markup survives", () => {
  it("keeps the eight permitted tags", () => {
    const input =
      "<b>b</b><strong>s</strong><i>i</i><em>e</em><u>u</u><s>st</s>a<br>b";
    expect(sanitizeInlineHtml(input)).toBe(input);
  });

  it("keeps an http link and its href", () => {
    expect(sanitizeInlineHtml('<a href="https://example.com">hi</a>')).toBe(
      '<a href="https://example.com">hi</a>',
    );
  });

  it("keeps a mailto link", () => {
    expect(sanitizeInlineHtml('<a href="mailto:a@b.com">mail</a>')).toBe(
      '<a href="mailto:a@b.com">mail</a>',
    );
  });

  it("keeps a span colour in the two accepted forms", () => {
    expect(sanitizeInlineHtml('<span style="color:#f00">x</span>')).toBe(
      '<span style="color:#f00">x</span>',
    );
    expect(
      sanitizeInlineHtml('<span style="color: rgb(1, 2, 3)">x</span>'),
    ).toBe('<span style="color:rgb(1, 2, 3)">x</span>');
  });
});

describe("script and handler vectors", () => {
  it("drops a script tag but keeps its text as text", () => {
    expect(sanitizeInlineHtml("a<script>alert(1)</script>b")).toBe(
      "aalert(1)b",
    );
  });

  it("drops an event handler along with its non-allowlisted element", () => {
    expect(sanitizeInlineHtml("<img src=x onerror=alert(1)>")).toBe("");
  });

  it("drops an event handler from an allowlisted element", () => {
    expect(sanitizeInlineHtml('<b onclick="alert(1)">x</b>')).toBe("<b>x</b>");
  });

  it("drops an svg payload entirely", () => {
    expect(sanitizeInlineHtml('<svg onload="alert(1)"><circle/></svg>')).toBe(
      "",
    );
  });
});

describe("url schemes", () => {
  it("drops a javascript: href but keeps the link text", () => {
    expect(sanitizeInlineHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      "<a>x</a>",
    );
  });

  it("drops a data: href", () => {
    expect(
      sanitizeInlineHtml('<a href="data:text/html,<script>1</script>">x</a>'),
    ).toBe("<a>x</a>");
  });

  /**
   * URL parsers ignore embedded C0 controls, so a scheme check run against the
   * raw value would let `java&#10;script:` through. `normalizeUrl` strips them
   * before the check rather than after.
   */
  it("drops a scheme smuggled past the check with a control character", () => {
    expect(sanitizeInlineHtml('<a href="java\nscript:alert(1)">x</a>')).toBe(
      "<a>x</a>",
    );
    expect(sanitizeInlineHtml('<a href=" \tjavascript:alert(1)">x</a>')).toBe(
      "<a>x</a>",
    );
  });

  it("drops a vbscript: href", () => {
    expect(sanitizeInlineHtml('<a href="vbscript:msgbox">x</a>')).toBe(
      "<a>x</a>",
    );
  });
});

describe("style attribute", () => {
  it("drops expression() rather than reconstructing it", () => {
    expect(
      sanitizeInlineHtml('<span style="width:expression(alert(1))">x</span>'),
    ).toBe("<span>x</span>");
  });

  it("drops url() smuggled alongside a valid colour", () => {
    // Only the `color` declaration is reconstructed; the rest cannot survive.
    expect(
      sanitizeInlineHtml(
        '<span style="color:#fff;background:url(javascript:1)">x</span>',
      ),
    ).toBe('<span style="color:#fff">x</span>');
  });

  it("drops a colour it cannot prove is a colour", () => {
    expect(sanitizeInlineHtml('<span style="color:red">x</span>')).toBe(
      "<span>x</span>",
    );
    expect(sanitizeInlineHtml('<span style="color:var(--x)">x</span>')).toBe(
      "<span>x</span>",
    );
  });

  it("drops style from an element that may not carry it", () => {
    expect(sanitizeInlineHtml('<b style="color:#fff">x</b>')).toBe("<b>x</b>");
  });
});

describe("structure", () => {
  it("closes tags left open", () => {
    expect(sanitizeInlineHtml("<b>bold")).toBe("<b>bold</b>");
  });

  it("ignores a closer with no opener", () => {
    expect(sanitizeInlineHtml("x</b>y")).toBe("xy");
  });

  it("closes through improperly nested tags", () => {
    expect(sanitizeInlineHtml("<b><i>x</b></i>")).toBe("<b><i>x</i></b>");
  });

  it("drops comments, doctypes and processing instructions", () => {
    expect(sanitizeInlineHtml("a<!-- c -->b<!doctype html>c<?pi?>d")).toBe(
      "abcd",
    );
  });

  it("treats an unparseable < as literal text", () => {
    expect(sanitizeInlineHtml("1 < 2 and 3 > 2")).toBe("1 &lt; 2 and 3 &gt; 2");
  });
});

describe("text escaping", () => {
  it("preserves a well-formed entity instead of double-escaping it", () => {
    expect(sanitizeInlineHtml("a &amp; b &nbsp; c")).toBe("a &amp; b &nbsp; c");
  });

  it("escapes a bare ampersand", () => {
    expect(sanitizeInlineHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("is idempotent", () => {
    const inputs = [
      "Tom & Jerry",
      "a &amp; b",
      '<a href="https://x.com">x</a>',
      "<b><i>x</b></i>",
      "1 < 2",
      '<span style="color:#abc">x</span>',
    ];
    for (const input of inputs) {
      const once = sanitizeInlineHtml(input);
      expect(sanitizeInlineHtml(once)).toBe(once);
    }
  });
});

describe("template variables are not markup", () => {
  it("passes {{name}} through byte-identically", () => {
    expect(sanitizeInlineHtml("Hello {{name}}, welcome")).toBe(
      "Hello {{name}}, welcome",
    );
  });

  it("keeps a variable inside a link href", () => {
    expect(sanitizeInlineHtml('<a href="https://x.com/{{id}}">go</a>')).toBe(
      '<a href="https://x.com/{{id}}">go</a>',
    );
  });

  it("keeps section tags intact", () => {
    expect(sanitizeInlineHtml("{{#items}}{{.}}{{/items}}")).toBe(
      "{{#items}}{{.}}{{/items}}",
    );
  });
});
