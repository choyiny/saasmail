import { describe, it, expect } from "vitest";
import {
  BlockDocumentSchema,
  MAX_BLOCKS,
  MAX_INLINE_HTML,
  MAX_LIST_ITEMS,
} from "../lib/blocks/schema";

const doc = (blocks: unknown[], theme?: unknown) => ({
  version: 1,
  ...(theme ? { theme } : {}),
  blocks,
});

const para = (html: string) => ({
  id: "b1",
  type: "paragraph",
  data: { html },
});

describe("document shape", () => {
  it("accepts a minimal document", () => {
    const parsed = BlockDocumentSchema.parse(doc([para("hello")]));
    expect(parsed.blocks).toHaveLength(1);
  });

  it("accepts an empty document", () => {
    expect(BlockDocumentSchema.parse(doc([])).blocks).toEqual([]);
  });

  it("rejects an unknown block type", () => {
    expect(() =>
      BlockDocumentSchema.parse(doc([{ id: "x", type: "carousel", data: {} }])),
    ).toThrow();
  });

  it("rejects a version it does not know", () => {
    expect(() =>
      BlockDocumentSchema.parse({ version: 2, blocks: [] }),
    ).toThrow();
  });
});

/**
 * The sanitizer is wired as a `.transform()` on `InlineHtmlSchema` precisely so
 * that no caller can validate a document without also sanitizing it. These
 * assert that property through the public schema, not through the sanitizer.
 */
describe("sanitization has no bypass", () => {
  it("sanitizes paragraph html during parse", () => {
    const parsed = BlockDocumentSchema.parse(
      doc([para('<script>alert(1)</script><b onclick="x">hi</b>')]),
    );
    expect(parsed.blocks[0]).toMatchObject({
      data: { html: "alert(1)<b>hi</b>" },
    });
  });

  it("sanitizes every list item", () => {
    const parsed = BlockDocumentSchema.parse(
      doc([
        {
          id: "l1",
          type: "list",
          data: { ordered: false, items: ["<b>a</b>", "<script>b</script>"] },
        },
      ]),
    );
    expect(parsed.blocks[0]).toMatchObject({
      data: { items: ["<b>a</b>", "b"] },
    });
  });

  it("sanitizes quote html", () => {
    const parsed = BlockDocumentSchema.parse(
      doc([
        {
          id: "q",
          type: "quote",
          data: { html: '<a href="javascript:1">x</a>' },
        },
      ]),
    );
    expect(parsed.blocks[0]).toMatchObject({ data: { html: "<a>x</a>" } });
  });
});

describe("urls", () => {
  it("rejects a data: image src rather than silently emitting it", () => {
    expect(() =>
      BlockDocumentSchema.parse(
        doc([
          {
            id: "i",
            type: "image",
            data: { src: "data:image/png;base64,AAAA", alt: "x" },
          },
        ]),
      ),
    ).toThrow(/data:/);
  });

  it("rejects a javascript: button href", () => {
    expect(() =>
      BlockDocumentSchema.parse(
        doc([
          {
            id: "b",
            type: "button",
            data: { label: "go", href: "javascript:alert(1)" },
          },
        ]),
      ),
    ).toThrow();
  });

  it("accepts an https image src and defaults alt to empty", () => {
    const parsed = BlockDocumentSchema.parse(
      doc([{ id: "i", type: "image", data: { src: "https://x.com/a.png" } }]),
    );
    expect(parsed.blocks[0]).toMatchObject({ data: { alt: "" } });
  });
});

describe("theme overrides are validated because they land in a style attribute", () => {
  it("accepts #rgb and #rrggbb", () => {
    expect(() =>
      BlockDocumentSchema.parse(doc([], { textColor: "#fff" })),
    ).not.toThrow();
    expect(() =>
      BlockDocumentSchema.parse(doc([], { textColor: "#ffffff" })),
    ).not.toThrow();
  });

  it("rejects a named colour, a function and an injection attempt", () => {
    for (const value of ["red", "var(--x)", "#fff;background:url(x)"]) {
      expect(() =>
        BlockDocumentSchema.parse(doc([], { textColor: value })),
      ).toThrow();
    }
  });

  it("rejects a length it cannot prove is a length", () => {
    expect(() =>
      BlockDocumentSchema.parse(doc([], { contentWidth: "1em" })),
    ).toThrow();
    expect(() =>
      BlockDocumentSchema.parse(doc([], { contentWidth: "600px" })),
    ).not.toThrow();
  });

  it("rejects an arbitrary font family", () => {
    expect(() =>
      BlockDocumentSchema.parse(doc([], { fontStack: "Comic Sans" })),
    ).toThrow();
  });
});

describe("limits", () => {
  it("accepts a document at the block ceiling and rejects one over it", () => {
    const at = Array.from({ length: MAX_BLOCKS }, (_, i) => ({
      ...para("x"),
      id: `b${i}`,
    }));
    expect(() => BlockDocumentSchema.parse(doc(at))).not.toThrow();
    expect(() =>
      BlockDocumentSchema.parse(doc([...at, { ...para("x"), id: "over" }])),
    ).toThrow(new RegExp(String(MAX_BLOCKS)));
  });

  it("rejects inline html over the character ceiling, naming the limit", () => {
    expect(() =>
      BlockDocumentSchema.parse(doc([para("a".repeat(MAX_INLINE_HTML + 1))])),
    ).toThrow(new RegExp(String(MAX_INLINE_HTML)));
  });

  it("rejects a list over the item ceiling", () => {
    expect(() =>
      BlockDocumentSchema.parse(
        doc([
          {
            id: "l",
            type: "list",
            data: {
              ordered: false,
              items: Array.from({ length: MAX_LIST_ITEMS + 1 }, () => "x"),
            },
          },
        ]),
      ),
    ).toThrow();
  });

  it("restricts heading levels to 1-3", () => {
    expect(() =>
      BlockDocumentSchema.parse(
        doc([{ id: "h", type: "heading", data: { level: 4, html: "x" } }]),
      ),
    ).toThrow();
  });
});
