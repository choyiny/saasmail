/**
 * The two block types Tiptap has no equivalent for.
 *
 * Everything else in the block schema maps onto StarterKit — paragraph,
 * heading, lists, blockquote, horizontal rule — so only the button and the
 * image need custom nodes. Both are **atoms**: they hold no editable inline
 * content, and their fields are edited through the node view rather than by
 * typing into the document.
 *
 * StarterKit's own `image` extension is deliberately not used. It would let an
 * author paste a `data:` URI straight into the document, which is exactly the
 * failure mode the asset pipeline exists to prevent.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { BUTTON_NODE, IMAGE_NODE } from "./serialize";

const FIELD_CLASS =
  "w-full rounded-[4px] border border-border bg-bg-base px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:border-text-tertiary focus:outline-none";

/** Shown under a selected atom so its fields can be edited in place. */
function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] font-medium text-text-tertiary">
        {label}
      </span>
      {children}
    </label>
  );
}

function ButtonView({ node, updateAttributes, selected }: NodeViewProps) {
  const { label, href, full, align } = node.attrs as {
    label: string;
    href: string;
    full: boolean;
    align: string | null;
  };

  return (
    <NodeViewWrapper
      className={`my-3 rounded-[6px] border p-2 transition-colors ${
        selected ? "border-violet/60 bg-violet/5" : "border-transparent"
      }`}
      data-drag-handle
    >
      <div
        style={{
          textAlign: (align as "left" | "center" | "right") ?? "center",
        }}
      >
        <span
          className="inline-block rounded-[6px] bg-text-primary px-6 py-2.5 text-xs font-semibold text-white"
          style={full ? { display: "block" } : undefined}
        >
          {label || "Button"}
        </span>
      </div>

      {selected && (
        <div
          className="mt-2 space-y-1.5"
          contentEditable={false}
          // Typing in these inputs must not reach the editor's keymap, or
          // space and Enter would insert nodes into the document instead.
          onKeyDown={(e) => e.stopPropagation()}
        >
          <FieldRow label="Label">
            <input
              className={FIELD_CLASS}
              value={label}
              placeholder="Read more"
              onChange={(e) => updateAttributes({ label: e.target.value })}
            />
          </FieldRow>
          <FieldRow label="Link">
            <input
              className={FIELD_CLASS}
              value={href}
              placeholder="https://example.com  or  {{cta_url}}"
              onChange={(e) => updateAttributes({ href: e.target.value })}
            />
          </FieldRow>
          <div className="flex items-center gap-3 pl-16 pt-0.5">
            <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={Boolean(full)}
                onChange={(e) => updateAttributes({ full: e.target.checked })}
              />
              Full width
            </label>
            <select
              className="rounded-[4px] border border-border bg-bg-base px-1.5 py-0.5 text-[11px] text-text-secondary"
              value={align ?? "center"}
              onChange={(e) => updateAttributes({ align: e.target.value })}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const EmailButton = Node.create({
  name: BUTTON_NODE,
  group: "block",
  atom: true,
  draggable: true,

  addAttributes: () => ({
    label: { default: "Read more" },
    href: { default: "" },
    full: { default: false },
    align: { default: "center" },
  }),

  parseHTML: () => [{ tag: `div[data-type="${BUTTON_NODE}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-type": BUTTON_NODE }),
  ],
  addNodeView: () => ReactNodeViewRenderer(ButtonView),
});

function ImageView({ node, updateAttributes, selected }: NodeViewProps) {
  const { src, alt, caption, href, align } = node.attrs as Record<
    string,
    string | null
  >;

  return (
    <NodeViewWrapper
      className={`my-3 rounded-[6px] border p-2 transition-colors ${
        selected ? "border-violet/60 bg-violet/5" : "border-transparent"
      }`}
      data-drag-handle
    >
      <div
        style={{
          textAlign: (align as "left" | "center" | "right") ?? "center",
        }}
      >
        {src ? (
          <img
            src={src}
            alt={alt ?? ""}
            className="inline-block max-w-full rounded-[4px]"
          />
        ) : (
          <span className="inline-block rounded-[4px] bg-bg-muted px-4 py-6 text-xs text-text-tertiary">
            No image
          </span>
        )}
        {caption && (
          <div className="mt-1 text-[11px] text-text-tertiary">{caption}</div>
        )}
      </div>

      {selected && (
        <div
          className="mt-2 space-y-1.5"
          contentEditable={false}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <FieldRow label="Alt text">
            <input
              className={FIELD_CLASS}
              value={alt ?? ""}
              placeholder="Describes the image for screen readers"
              onChange={(e) => updateAttributes({ alt: e.target.value })}
            />
          </FieldRow>
          <FieldRow label="Caption">
            <input
              className={FIELD_CLASS}
              value={caption ?? ""}
              placeholder="Optional"
              onChange={(e) =>
                updateAttributes({ caption: e.target.value || null })
              }
            />
          </FieldRow>
          <FieldRow label="Links to">
            <input
              className={FIELD_CLASS}
              value={href ?? ""}
              placeholder="Optional — https://example.com"
              onChange={(e) =>
                updateAttributes({ href: e.target.value || null })
              }
            />
          </FieldRow>
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const EmailImage = Node.create({
  name: IMAGE_NODE,
  group: "block",
  atom: true,
  draggable: true,

  addAttributes: () => ({
    src: { default: "" },
    alt: { default: "" },
    width: { default: null },
    href: { default: null },
    caption: { default: null },
    align: { default: "center" },
  }),

  parseHTML: () => [{ tag: `img[data-type="${IMAGE_NODE}"]` }],
  renderHTML: ({ HTMLAttributes }) => [
    "img",
    mergeAttributes(HTMLAttributes, { "data-type": IMAGE_NODE }),
  ],
  addNodeView: () => ReactNodeViewRenderer(ImageView),
});
