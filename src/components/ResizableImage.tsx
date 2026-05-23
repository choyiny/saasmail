import Image from "@tiptap/extension-image";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useEffect, useRef, useState } from "react";

/**
 * Tiptap Image extension that lets users drag a corner handle to resize.
 * The width is stored as an inline attribute (in pixels) on the rendered
 * <img>, so it round-trips through HTML serialization and DOMPurify
 * untouched. Height is kept fluid via `height: auto` in CSS to preserve
 * aspect ratio.
 */
const MIN_WIDTH = 50;

function ResizableImageView({
  node,
  selected,
  updateAttributes,
  editor,
}: NodeViewProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  // Tracks a width override while the user is dragging so we don't commit
  // an updateAttributes call on every mousemove (which would flood undo
  // history and re-render the editor at 60Hz).
  const [draftWidth, setDraftWidth] = useState<number | null>(null);

  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string | undefined) ?? "";
  const title = (node.attrs.title as string | undefined) ?? "";
  const widthAttr = node.attrs.width as number | string | null | undefined;

  const isEditable = editor.isEditable;

  function handlePointerDown(event: React.PointerEvent<HTMLSpanElement>) {
    if (!isEditable) return;
    event.preventDefault();
    event.stopPropagation();
    const img = imgRef.current;
    if (!img) return;

    const startX = event.clientX;
    const startWidth = img.getBoundingClientRect().width;
    // Cap dragging at the editor's content width so the handle can't be
    // dragged off into space — the image visually maxes out at 100% anyway.
    const containerWidth =
      img.parentElement?.parentElement?.getBoundingClientRect().width ??
      Infinity;

    function onMove(e: PointerEvent) {
      const delta = e.clientX - startX;
      let next = startWidth + delta;
      if (next < MIN_WIDTH) next = MIN_WIDTH;
      if (next > containerWidth) next = containerWidth;
      setDraftWidth(next);
    }
    function onUp(e: PointerEvent) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const delta = e.clientX - startX;
      let next = startWidth + delta;
      if (next < MIN_WIDTH) next = MIN_WIDTH;
      if (next > containerWidth) next = containerWidth;
      setDraftWidth(null);
      updateAttributes({ width: Math.round(next) });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // If the node's width changes from elsewhere (e.g. paste), drop any
  // stale local draft so the img reflects the canonical attribute.
  useEffect(() => {
    setDraftWidth(null);
  }, [widthAttr]);

  const displayedWidth =
    draftWidth !== null
      ? `${Math.round(draftWidth)}px`
      : widthAttr
        ? typeof widthAttr === "number"
          ? `${widthAttr}px`
          : String(widthAttr)
        : undefined;

  return (
    <NodeViewWrapper
      as="span"
      className="notion-image-wrapper"
      data-selected={selected ? "true" : undefined}
      // Inline-block so the wrapper hugs the image and the handle sits
      // flush with its bottom-right corner.
      style={{
        display: "inline-block",
        position: "relative",
        maxWidth: "100%",
      }}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        title={title || undefined}
        className="notion-image"
        width={
          typeof widthAttr === "number"
            ? widthAttr
            : draftWidth !== null
              ? Math.round(draftWidth)
              : undefined
        }
        style={displayedWidth ? { width: displayedWidth } : undefined}
        draggable={false}
      />
      {isEditable && (
        <span
          role="slider"
          aria-label="Resize image"
          aria-valuemin={MIN_WIDTH}
          aria-valuenow={
            draftWidth !== null
              ? Math.round(draftWidth)
              : typeof widthAttr === "number"
                ? widthAttr
                : Math.round(imgRef.current?.getBoundingClientRect().width ?? 0)
          }
          className="notion-image-resize-handle"
          onPointerDown={handlePointerDown}
          contentEditable={false}
          data-visible={selected || draftWidth !== null ? "true" : undefined}
        />
      )}
    </NodeViewWrapper>
  );
}

export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        // Parse from either the HTML width attribute or an inline
        // `width: NNNpx` style so pasted/loaded content keeps its size.
        parseHTML: (element) => {
          const attr = element.getAttribute("width");
          if (attr) {
            const n = parseInt(attr, 10);
            if (!Number.isNaN(n)) return n;
            return attr;
          }
          const style = element.getAttribute("style") ?? "";
          const m = style.match(/width:\s*(\d+(?:\.\d+)?)px/i);
          if (m) return Math.round(parseFloat(m[1] ?? "0"));
          return null;
        },
        renderHTML: (attrs) => {
          if (attrs.width == null || attrs.width === "") return {};
          // Render BOTH the width attribute and an inline style so the
          // size survives strict email HTML sanitizers that strip one or
          // the other.
          return {
            width: String(attrs.width),
            style: `width: ${typeof attrs.width === "number" ? attrs.width + "px" : attrs.width}; height: auto;`,
          };
        },
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView);
  },
});

export default ResizableImage;
