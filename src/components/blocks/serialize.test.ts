import { describe, it, expect } from "vitest";
import {
  serialize,
  deserialize,
  inlineToHtml,
  htmlToInline,
  BUTTON_NODE,
  IMAGE_NODE,
  type TiptapNode,
} from "./serialize";
import { BlockDocumentSchema } from "@worker/lib/blocks/schema";
import { compile } from "@worker/lib/blocks/compile";

const doc = (...content: TiptapNode[]): TiptapNode => ({
  type: "doc",
  content,
});
const text = (t: string, ...marks: string[]): TiptapNode => ({
  type: "text",
  text: t,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});
const para = (...content: TiptapNode[]): TiptapNode => ({
  type: "paragraph",
  content,
});

describe("inline serialization", () => {
  it("escapes text so it cannot become markup", () => {
    expect(inlineToHtml([text("1 < 2 & 3 > 2")])).toBe(
      "1 &lt; 2 &amp; 3 &gt; 2",
    );
  });

  it("maps each mark to its allowlisted tag", () => {
    expect(inlineToHtml([text("a", "bold")])).toBe("<strong>a</strong>");
    expect(inlineToHtml([text("a", "italic")])).toBe("<em>a</em>");
    expect(inlineToHtml([text("a", "underline")])).toBe("<u>a</u>");
    expect(inlineToHtml([text("a", "strike")])).toBe("<s>a</s>");
  });

  /**
   * Mark order is fixed rather than taken from Tiptap's reporting order, so the
   * same document always serializes to the same bytes. Without that the
   * preview-vs-stored comparison would flap.
   */
  it("nests marks in a stable order regardless of input order", () => {
    const forward = inlineToHtml([
      {
        type: "text",
        text: "x",
        marks: [{ type: "bold" }, { type: "italic" }],
      },
    ]);
    const reverse = inlineToHtml([
      {
        type: "text",
        text: "x",
        marks: [{ type: "italic" }, { type: "bold" }],
      },
    ]);
    expect(forward).toBe(reverse);
    expect(forward).toBe("<em><strong>x</strong></em>");
  });

  it("emits a link with an escaped href", () => {
    expect(
      inlineToHtml([
        {
          type: "text",
          text: "go",
          marks: [{ type: "link", attrs: { href: "https://x.com/?a=1&b=2" } }],
        },
      ]),
    ).toBe('<a href="https://x.com/?a=1&amp;b=2">go</a>');
  });

  it("drops a link with no href rather than emitting a dead anchor", () => {
    expect(
      inlineToHtml([
        { type: "text", text: "go", marks: [{ type: "link", attrs: {} }] },
      ]),
    ).toBe("go");
  });

  it("ignores a mark the compiler has no tag for", () => {
    expect(inlineToHtml([text("x", "highlight")])).toBe("x");
  });

  it("turns a hard break into <br>", () => {
    expect(inlineToHtml([text("a"), { type: "hardBreak" }, text("b")])).toBe(
      "a<br>b",
    );
  });
});

describe("serialize produces a valid block document", () => {
  it("validates against the schema for every node type", () => {
    const d = serialize(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
        para(text("Hello "), text("world", "bold")),
        { type: "horizontalRule" },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [para(text("one"))] },
            { type: "listItem", content: [para(text("two"))] },
          ],
        },
        { type: "blockquote", content: [para(text("quoted"))] },
        {
          type: BUTTON_NODE,
          attrs: { label: "Go", href: "https://example.com" },
        },
        {
          type: IMAGE_NODE,
          attrs: { src: "https://cdn.example.com/a.png", alt: "A" },
        },
      ),
    );

    expect(BlockDocumentSchema.safeParse(d).success).toBe(true);
    expect(d.blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "separator",
      "list",
      "quote",
      "button",
      "image",
    ]);
  });

  it("validates an empty document", () => {
    const d = serialize(doc());
    expect(BlockDocumentSchema.safeParse(d).success).toBe(true);
    expect(d.blocks).toEqual([]);
  });

  /**
   * A trailing empty paragraph is where the cursor was left, not content. It
   * would compile to an empty table row and add stray vertical space to every
   * send.
   */
  it("drops empty paragraphs", () => {
    const d = serialize(doc(para(text("real")), para(), { type: "paragraph" }));
    expect(d.blocks).toHaveLength(1);
  });

  it("clamps a heading level the compiler cannot emit", () => {
    const d = serialize(
      doc({ type: "heading", attrs: { level: 6 }, content: [text("deep")] }),
    );
    expect(BlockDocumentSchema.safeParse(d).success).toBe(true);
    expect((d.blocks[0] as any).data.level).toBe(3);
  });

  it("carries alignment through when a node has it", () => {
    const d = serialize(
      doc({
        type: "paragraph",
        attrs: { textAlign: "center" },
        content: [text("x")],
      }),
    );
    expect((d.blocks[0] as any).align).toBe("center");
  });

  it("gives blocks positional ids so output is deterministic", () => {
    const input = doc(para(text("a")), para(text("b")));
    expect(serialize(input)).toEqual(serialize(input));
    expect(serialize(input).blocks.map((b) => b.id)).toEqual(["b0", "b1"]);
  });
});

describe("round trip", () => {
  const original = doc(
    { type: "heading", attrs: { level: 1 }, content: [text("Title")] },
    para(text("Plain "), text("bold", "bold"), text(" tail")),
    {
      type: "orderedList",
      content: [
        { type: "listItem", content: [para(text("one"))] },
        { type: "listItem", content: [para(text("two"))] },
      ],
    },
    { type: "blockquote", content: [para(text("quoted"))] },
    { type: "horizontalRule" },
    { type: BUTTON_NODE, attrs: { label: "Go", href: "https://example.com" } },
  );

  it("survives serialize → deserialize → serialize unchanged", () => {
    const once = serialize(original);
    const twice = serialize(deserialize(once));
    expect(twice).toEqual(once);
  });

  it("preserves link hrefs across the round trip", () => {
    const withLink = doc(
      para({
        type: "text",
        text: "go",
        marks: [{ type: "link", attrs: { href: "https://x.com/a?b=1&c=2" } }],
      }),
    );
    const once = serialize(withLink);
    expect(serialize(deserialize(once))).toEqual(once);
  });

  it("never produces an empty ProseMirror document", () => {
    expect(deserialize(serialize(doc())).content).toHaveLength(1);
  });
});

/**
 * The payoff for keeping the compiler pure: the editor's preview is not an
 * approximation of the email, it is the same function the worker runs on save.
 */
describe("the editor can compile its own document", () => {
  it("compiles a serialized document to the same HTML the server would store", () => {
    const parsed = BlockDocumentSchema.parse(
      serialize(
        doc(
          { type: "heading", attrs: { level: 1 }, content: [text("Hi")] },
          para(text("Hello {{first_name}}")),
        ),
      ),
    );

    const html = compile(parsed);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Hello {{first_name}}");
    expect(compile(parsed)).toBe(html);
  });

  it("sanitizes on the way through the schema, not in the editor", () => {
    const raw = serialize(doc(para(text("<script>alert(1)</script>"))));
    // The serializer escapes, so the payload is already inert as text.
    expect((raw.blocks[0] as any).data.html).not.toContain("<script>");

    const parsed = BlockDocumentSchema.parse(raw);
    expect(compile(parsed)).not.toContain("<script>");
  });
});

describe("htmlToInline", () => {
  it("decodes entities back to text", () => {
    expect(htmlToInline("1 &lt; 2 &amp; 3")).toEqual([
      { type: "text", text: "1 < 2 & 3" },
    ]);
  });

  it("reads nested marks back", () => {
    expect(htmlToInline("<em><strong>x</strong></em>")).toEqual([
      {
        type: "text",
        text: "x",
        marks: [{ type: "italic" }, { type: "bold" }],
      },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(htmlToInline("")).toEqual([]);
  });
});
