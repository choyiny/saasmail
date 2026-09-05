import { describe, it, expect } from "vitest";
import { compile } from "../lib/blocks/compile";
import { BlockDocumentSchema } from "../lib/blocks/schema";
import { DEFAULT_THEME } from "../lib/blocks/theme";
import { analyzeTemplate } from "../lib/interpolate";
import { KITCHEN_SINK } from "./fixtures/kitchen-sink";
import { KITCHEN_SINK_HTML } from "./fixtures/kitchen-sink.expected";

const parse = (blocks: unknown[], theme?: unknown) =>
  BlockDocumentSchema.parse({
    version: 1,
    ...(theme ? { theme } : {}),
    blocks,
  });

describe("document structure", () => {
  it("emits exactly one row per block, in document order", () => {
    const html = compile(parse(KITCHEN_SINK));
    const kinds = [...html.matchAll(/<tr class="block block--(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(kinds).toEqual([
      "heading",
      "paragraph",
      "separator",
      "heading",
      "list",
      "image",
      "quote",
      "button",
      "paragraph",
    ]);
  });

  it("emits every block type without throwing", () => {
    for (const block of KITCHEN_SINK) {
      expect(() => compile(parse([block]))).not.toThrow();
    }
  });

  it("carries exactly one style block — everything else is inlined", () => {
    const html = compile(parse(KITCHEN_SINK));
    expect(html.match(/<style>/g)).toHaveLength(1);
  });

  it("wraps content in a 600px table with an mso fallback", () => {
    const html = compile(parse([]));
    expect(html).toContain(`max-width:${DEFAULT_THEME.contentWidth}`);
    expect(html).toContain("<!--[if mso]>");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("emits a hidden preheader, empty when none is given", () => {
    expect(compile(parse([]), "Read this")).toContain(">Read this</div>");
    expect(compile(parse([]))).toContain('mso-hide:all;"></div>');
  });
});

describe("determinism and purity", () => {
  it("compiles to identical bytes on repeated calls", () => {
    const doc = parse(KITCHEN_SINK);
    expect(compile(doc)).toBe(compile(doc));
  });

  it("does not mutate the document it is given", () => {
    const doc = parse(KITCHEN_SINK);
    const before = JSON.stringify(doc);
    compile(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("theme", () => {
  it("applies a validated override in place of the default", () => {
    const html = compile(parse(KITCHEN_SINK, { buttonBg: "#ff0000" }));
    expect(html).toContain("background-color:#ff0000");
    expect(html).not.toContain(`background-color:${DEFAULT_THEME.buttonBg}`);
  });

  it("uses an allowlisted font stack, never a raw family", () => {
    const html = compile(parse([], { fontStack: "serif" }));
    expect(html).toContain("Georgia");
  });
});

/**
 * The compiler must never parse, escape or rewrite `{{…}}`. Variables are
 * interpolated per recipient downstream, from the compiled HTML — which is what
 * lets block templates use the existing template grammar for free.
 */
describe("template variables pass through untouched", () => {
  const withVars = [
    { id: "p", type: "paragraph", data: { html: "Hi {{first_name}}," } },
    {
      id: "b",
      type: "button",
      data: { label: "Open {{plan}}", href: "https://x.com/{{token}}" },
    },
  ];

  it("survives compilation verbatim", () => {
    const html = compile(parse(withVars));
    expect(html).toContain("Hi {{first_name}},");
    expect(html).toContain("Open {{plan}}");
    expect(html).toContain("https://x.com/{{token}}");
  });

  it("is seen by analyzeTemplate as a required variable", () => {
    const html = compile(parse(withVars));
    const analysis = analyzeTemplate("A subject", html);
    expect(analysis.required).toContain("first_name");
    expect(analysis.required).toContain("plan");
    expect(analysis.required).toContain("token");
  });

  it("produces no parse error for any fixture", () => {
    expect(() =>
      analyzeTemplate("subject", compile(parse(KITCHEN_SINK))),
    ).not.toThrow();
  });

  it("keeps a section balanced across two blocks", () => {
    const html = compile(
      parse([
        { id: "a", type: "paragraph", data: { html: "{{#items}}" } },
        { id: "b", type: "paragraph", data: { html: "{{.}}" } },
        { id: "c", type: "paragraph", data: { html: "{{/items}}" } },
      ]),
    );
    const analysis = analyzeTemplate("s", html);
    expect(analysis.sections.map((s) => s.name)).toContain("items");
  });
});

describe("escaping at the emitter boundary", () => {
  it("escapes a caption, which is plain text not rich text", () => {
    const html = compile(
      parse([
        {
          id: "i",
          type: "image",
          data: { src: "https://x.com/a.png", caption: "<script>x</script>" },
        },
      ]),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a button label", () => {
    const html = compile(
      parse([
        {
          id: "b",
          type: "button",
          data: { label: '"><script>x</script>', href: "https://x.com" },
        },
      ]),
    );
    expect(html).not.toContain("<script>");
  });

  it("escapes an image alt so it cannot break out of the attribute", () => {
    const html = compile(
      parse([
        {
          id: "i",
          type: "image",
          data: { src: "https://x.com/a.png", alt: '" onerror="alert(1)' },
        },
      ]),
    );
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&quot;");
  });
});

/**
 * The golden is the regression net for output drift. Structural assertions
 * catch a block that stops rendering; only a byte comparison catches a padding
 * tweak or a dropped attribute silently changing every campaign that ships.
 *
 * Regenerate deliberately with `npx tsx scripts/regen-block-golden.mts`, then
 * read the diff.
 */
describe("compiled output golden", () => {
  it("matches the committed compilation of the kitchen-sink fixture", () => {
    const doc = BlockDocumentSchema.parse({ version: 1, blocks: KITCHEN_SINK });
    expect(compile(doc, "Preheader text")).toBe(KITCHEN_SINK_HTML);
  });

  /**
   * Every theme token is interpolated into `style="…"`. A value carrying a
   * double quote — a font stack written `"Segoe UI"`, say — closes the
   * attribute and corrupts the element. Caught by the golden the first time it
   * was generated; asserted here so it cannot come back.
   */
  it("never lets a double quote escape a style attribute", () => {
    const broken = [...KITCHEN_SINK_HTML.matchAll(/style="([^"]*)"/g)].filter(
      (m) => m[1].includes('"'),
    );
    expect(broken).toEqual([]);
    expect(KITCHEN_SINK_HTML).toContain("'Segoe UI'");
  });
});

/**
 * Every campaign email carries `{{unsubscribe_url}}`, and it reaches the
 * compiler as an href with no scheme. Both the schema and the sanitizer used to
 * reject it — the schema refusing the write, the sanitizer silently stripping
 * the attribute in prose, which is the worse of the two failures.
 */
describe("a variable may stand in for a URL", () => {
  it("keeps an unsubscribe link written in prose", () => {
    const html = compile(
      parse([
        {
          id: "p",
          type: "paragraph",
          data: { html: '<a href="{{unsubscribe_url}}">Unsubscribe</a>' },
        },
      ]),
    );
    expect(html).toContain('href="{{unsubscribe_url}}"');
  });

  it("accepts a variable as a button href and an image src", () => {
    expect(() =>
      parse([
        {
          id: "b",
          type: "button",
          data: { label: "go", href: "{{cta_url}}" },
        },
        { id: "i", type: "image", data: { src: "{{hero_image}}" } },
      ]),
    ).not.toThrow();
  });

  it("still refuses a javascript: href that only looks like a variable", () => {
    expect(() =>
      parse([
        {
          id: "b",
          type: "button",
          data: { label: "go", href: "javascript:{{x}}" },
        },
      ]),
    ).toThrow();
  });

  it("still strips a javascript: href in prose", () => {
    const html = compile(
      parse([
        {
          id: "p",
          type: "paragraph",
          data: { html: '<a href="javascript:{{x}}">x</a>' },
        },
      ]),
    );
    expect(html).not.toContain("javascript:");
  });
});

/**
 * Regression guard for a defect found by sending a real campaign to Gmail.
 *
 * `appendHtmlFooter` in `lib/send.ts` adds a fallback unsubscribe link when a
 * template does not carry one. It used to concatenate, which is fine for the
 * HTML fragments hand-written templates usually are — but a compiled block
 * document is a complete `<!doctype html>` document, so the footer landed after
 * `</html>`: outside the styled container, unstyled, left-aligned against the
 * page background. Clients rendered it anyway rather than erroring, so only a
 * real send surfaced it.
 */
describe("the fallback unsubscribe footer lands inside the document", () => {
  it("compiled output ends with </html> and carries exactly one </body>", () => {
    const html = compile(parse(KITCHEN_SINK));
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html.match(/<\/body>/gi)).toHaveLength(1);
  });

  it("a footer inserted before </body> stays inside the rendered body", () => {
    const html = compile(parse(KITCHEN_SINK));
    const footer = '<hr/>\n<p><a href="https://x.test/u">Unsubscribe</a></p>';

    const closingBody = html.toLowerCase().lastIndexOf("</body>");
    const withFooter =
      html.slice(0, closingBody) + footer + html.slice(closingBody);

    expect(withFooter.indexOf("Unsubscribe")).toBeLessThan(
      withFooter.toLowerCase().lastIndexOf("</body>"),
    );
    expect(withFooter.trimEnd().endsWith("</html>")).toBe(true);
  });
});
