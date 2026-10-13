/**
 * Tiptap document ⇄ block document.
 *
 * Both directions operate on Tiptap's **JSON**, not on an `Editor` instance, so
 * they are plain functions over plain objects and can be unit-tested without
 * mounting an editor or a DOM.
 *
 * `serialize` is the inverse of `deserialize`, and the round trip is what the
 * editor relies on when it loads a saved template. The pair is deliberately
 * total in one direction only: anything the editor can produce serializes, but
 * a block document written by the API could in principle carry inline markup
 * the editor has no node for — those are preserved as HTML rather than dropped,
 * because silently discarding an author's content is worse than rendering it
 * read-only.
 */

import { escapeHtml } from "@worker/lib/blocks/shell";
import type { BlockDocument } from "@worker/lib/blocks/schema";

export type TiptapMark = { type: string; attrs?: Record<string, unknown> };

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
};

/** Node names for the two custom atoms. */
export const BUTTON_NODE = "emailButton";
export const IMAGE_NODE = "emailImage";

/**
 * Marks, innermost first.
 *
 * A fixed order rather than the order Tiptap happens to report, so the same
 * document always serializes to the same bytes — the preview is compared
 * against the stored HTML, and an unstable ordering would make that comparison
 * flap for no reason.
 */
const MARK_ORDER = ["bold", "italic", "underline", "strike", "link"] as const;

function wrapMark(html: string, mark: TiptapMark): string {
  switch (mark.type) {
    case "bold":
      return `<strong>${html}</strong>`;
    case "italic":
      return `<em>${html}</em>`;
    case "underline":
      return `<u>${html}</u>`;
    case "strike":
      return `<s>${html}</s>`;
    case "link": {
      const href = String(mark.attrs?.href ?? "");
      // An empty href would serialize to `<a href="">`, which the sanitizer
      // strips anyway — emit the text unlinked instead of a dead anchor.
      return href ? `<a href="${escapeHtml(href)}">${html}</a>` : html;
    }
    default:
      // An unknown mark contributes no markup. The sanitizer would strip it on
      // the way in regardless; dropping it here keeps the two consistent.
      return html;
  }
}

/** Serialize inline content (text nodes, marks, hard breaks) to HTML. */
export function inlineToHtml(nodes: TiptapNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((node) => {
      if (node.type === "hardBreak") return "<br>";
      if (node.type !== "text" || node.text === undefined) return "";

      let html = escapeHtml(node.text);
      const marks = node.marks ?? [];
      for (const name of MARK_ORDER) {
        const mark = marks.find((m) => m.type === name);
        if (mark) html = wrapMark(html, mark);
      }
      return html;
    })
    .join("");
}

/** Inline HTML back into Tiptap text nodes. Handles what `inlineToHtml` emits. */
export function htmlToInline(html: string): TiptapNode[] {
  if (!html) return [];

  const out: TiptapNode[] = [];
  const open: TiptapMark[] = [];
  let i = 0;

  const pushText = (text: string) => {
    if (!text) return;
    // `replace(/x/g, …)` rather than `replaceAll`: `tsconfig.app.json` targets
    // ES2020, and this module is inside that program. `&amp;` is decoded last
    // so `&amp;lt;` round-trips to `&lt;` instead of collapsing to `<`.
    const decoded = text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
    out.push({
      type: "text",
      text: decoded,
      ...(open.length ? { marks: open.map((m) => ({ ...m })) } : {}),
    });
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    pushText(html.slice(i, lt));

    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      pushText(html.slice(lt));
      break;
    }

    const tag = html.slice(lt + 1, gt);
    i = gt + 1;

    if (tag === "br" || tag === "br/") {
      out.push({ type: "hardBreak" });
      continue;
    }
    if (tag.startsWith("/")) {
      open.pop();
      continue;
    }

    const name = tag.split(/[\s>]/)[0].toLowerCase();
    const type = {
      strong: "bold",
      b: "bold",
      em: "italic",
      i: "italic",
      u: "underline",
      s: "strike",
      a: "link",
    }[name];
    if (!type) continue;

    if (type === "link") {
      const href = /href="([^"]*)"/.exec(tag)?.[1] ?? "";
      open.push({
        type: "link",
        attrs: { href: href.replace(/&amp;/g, "&") },
      });
    } else {
      open.push({ type });
    }
  }

  return out;
}

const align = (node: TiptapNode) => {
  const value = node.attrs?.textAlign ?? node.attrs?.align;
  return value === "left" || value === "center" || value === "right"
    ? { align: value }
    : {};
};

/**
 * Convert a Tiptap document into a block document.
 *
 * Block ids are positional (`b0`, `b1`, …) rather than random. They exist to
 * give the compiler a stable handle per row; making them positional keeps
 * serialization deterministic, which is what lets the editor assert that its
 * preview is byte-identical to what the server stored.
 */
export function serialize(doc: TiptapNode): BlockDocument {
  const blocks: unknown[] = [];

  for (const node of doc.content ?? []) {
    const id = `b${blocks.length}`;

    switch (node.type) {
      case "paragraph": {
        const html = inlineToHtml(node.content);
        // An empty paragraph is how the editor represents a blank line. It is
        // not content, and a run of them at the end of a document is just where
        // the cursor was left.
        if (!html.trim()) break;
        blocks.push({ id, type: "paragraph", data: { html }, ...align(node) });
        break;
      }
      case "heading": {
        const raw = Number(node.attrs?.level ?? 1);
        const level = raw >= 1 && raw <= 3 ? raw : 3;
        blocks.push({
          id,
          type: "heading",
          data: { level, html: inlineToHtml(node.content) },
          ...align(node),
        });
        break;
      }
      case "bulletList":
      case "orderedList": {
        const items = (node.content ?? []).map((li) =>
          (li.content ?? []).map((p) => inlineToHtml(p.content)).join("<br>"),
        );
        blocks.push({
          id,
          type: "list",
          data: { ordered: node.type === "orderedList", items },
        });
        break;
      }
      case "blockquote": {
        const html = (node.content ?? [])
          .map((p) => inlineToHtml(p.content))
          .join("<br>");
        blocks.push({
          id,
          type: "quote",
          data: {
            html,
            ...(node.attrs?.caption
              ? { caption: String(node.attrs.caption) }
              : {}),
          },
        });
        break;
      }
      case "horizontalRule":
        blocks.push({ id, type: "separator", data: {} });
        break;
      case BUTTON_NODE:
        blocks.push({
          id,
          type: "button",
          data: {
            label: String(node.attrs?.label ?? ""),
            href: String(node.attrs?.href ?? ""),
            ...(node.attrs?.full ? { full: true } : {}),
          },
          ...align(node),
        });
        break;
      case IMAGE_NODE:
        blocks.push({
          id,
          type: "image",
          data: {
            src: String(node.attrs?.src ?? ""),
            alt: String(node.attrs?.alt ?? ""),
            ...(node.attrs?.width ? { width: String(node.attrs.width) } : {}),
            ...(node.attrs?.href ? { href: String(node.attrs.href) } : {}),
            ...(node.attrs?.caption
              ? { caption: String(node.attrs.caption) }
              : {}),
          },
          ...align(node),
        });
        break;
      default:
        // Unknown node types are skipped rather than guessed at. The editor
        // only enables the extensions above, so this is unreachable in the UI
        // and exists for documents that arrived through the API.
        break;
    }
  }

  return { version: 1, blocks } as BlockDocument;
}

/** Convert a stored block document back into Tiptap content. */
export function deserialize(doc: BlockDocument): TiptapNode {
  const content: TiptapNode[] = [];

  for (const block of doc.blocks as unknown as Array<{
    type: string;
    data: Record<string, unknown>;
    align?: string;
  }>) {
    const attrs = block.align ? { textAlign: block.align } : undefined;

    switch (block.type) {
      case "paragraph":
        content.push({
          type: "paragraph",
          ...(attrs ? { attrs } : {}),
          content: htmlToInline(String(block.data.html ?? "")),
        });
        break;
      case "heading":
        content.push({
          type: "heading",
          attrs: { level: Number(block.data.level ?? 1), ...attrs },
          content: htmlToInline(String(block.data.html ?? "")),
        });
        break;
      case "list":
        content.push({
          type: block.data.ordered ? "orderedList" : "bulletList",
          content: ((block.data.items as string[]) ?? []).map((item) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: htmlToInline(item) }],
          })),
        });
        break;
      case "quote":
        content.push({
          type: "blockquote",
          ...(block.data.caption
            ? { attrs: { caption: block.data.caption } }
            : {}),
          content: [
            {
              type: "paragraph",
              content: htmlToInline(String(block.data.html ?? "")),
            },
          ],
        });
        break;
      case "separator":
        content.push({ type: "horizontalRule" });
        break;
      case "button":
        content.push({
          type: BUTTON_NODE,
          attrs: {
            label: block.data.label ?? "",
            href: block.data.href ?? "",
            full: block.data.full ?? false,
            align: block.align ?? null,
          },
        });
        break;
      case "image":
        content.push({
          type: IMAGE_NODE,
          attrs: {
            src: block.data.src ?? "",
            alt: block.data.alt ?? "",
            width: block.data.width ?? null,
            href: block.data.href ?? null,
            caption: block.data.caption ?? null,
            align: block.align ?? null,
          },
        });
        break;
    }
  }

  // ProseMirror will not accept a document with no content.
  if (content.length === 0) content.push({ type: "paragraph" });
  return { type: "doc", content };
}
