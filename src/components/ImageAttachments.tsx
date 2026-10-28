import { useCallback, useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import type { Attachment } from "@/lib/api";
import { cn } from "@/lib/utils";
// Shared with the worker, which serves only these types inline.
import { isInlineImageType } from "@worker/lib/inline-image-types";

/** An attachment the viewer can show — not an embedded CID image. */
export function isViewableImage(att: Attachment): boolean {
  return !att.contentId && isInlineImageType(att.contentType);
}

/**
 * Split a message's attachments into images to preview and files to download.
 * Embedded (CID) images are excluded from both: the body already shows them.
 */
export function splitAttachments(attachments: Attachment[] | undefined): {
  images: Attachment[];
  files: Attachment[];
} {
  const images: Attachment[] = [];
  const files: Attachment[] = [];
  for (const att of attachments ?? []) {
    if (att.contentId) continue;
    (isViewableImage(att) ? images : files).push(att);
  }
  return { images, files };
}

const inlineUrl = (att: Attachment) => `/api/attachments/${att.id}/inline`;
const downloadUrl = (att: Attachment) => `/api/attachments/${att.id}`;

/**
 * A message's image attachments as thumbnails. Clicking one opens it full
 * size in an in-app viewer, the way Gmail does, instead of downloading it.
 */
export default function ImageAttachments({
  images,
  size = "md",
  className,
}: {
  images: Attachment[];
  /** `sm` for compact chat bubbles, `md` elsewhere. */
  size?: "sm" | "md";
  className?: string;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (images.length === 0) return null;

  const box = size === "sm" ? "h-20 w-20" : "h-28 w-28";

  return (
    <>
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {images.map((att, i) => (
          <button
            key={att.id}
            type="button"
            onClick={(e) => {
              // Thread rows toggle or mark-read on click; opening an image
              // must not also do that.
              e.stopPropagation();
              setOpenIndex(i);
            }}
            title={att.filename}
            aria-label={`View ${att.filename}`}
            data-testid={`image-attachment-${att.id}`}
            className={cn(
              "overflow-hidden rounded-[8px] border border-border bg-bg-muted transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              box,
            )}
          >
            <img
              src={inlineUrl(att)}
              alt={att.filename}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </button>
        ))}
      </div>

      <ImageViewer
        images={images}
        index={openIndex}
        onIndexChange={setOpenIndex}
      />
    </>
  );
}

/** Full-size viewer over the page, with arrows between a message's images. */
export function ImageViewer({
  images,
  index,
  onIndexChange,
}: {
  images: Attachment[];
  /** Null = closed. */
  index: number | null;
  onIndexChange: (index: number | null) => void;
}) {
  const open = index !== null && images[index] !== undefined;
  const current = open ? images[index] : null;
  const many = images.length > 1;

  const step = useCallback(
    (delta: number) => {
      if (index === null) return;
      onIndexChange((index + delta + images.length) % images.length);
    },
    [index, images.length, onIndexChange],
  );

  useEffect(() => {
    if (!open || !many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, many, step]);

  const iconButton =
    "inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20";

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => !next && onIndexChange(null)}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/85" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-[60] flex flex-col outline-none"
          onClick={(e) => e.stopPropagation()}
          aria-describedby={undefined}
          data-testid="image-viewer"
        >
          {current && (
            <>
              <div className="flex shrink-0 items-center gap-3 px-4 py-3 text-white">
                <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-medium">
                  {current.filename}
                  {many && (
                    <span className="ml-2 font-light text-white/60">
                      {index! + 1} / {images.length}
                    </span>
                  )}
                </DialogPrimitive.Title>
                <a
                  href={downloadUrl(current)}
                  className={iconButton}
                  title="Download"
                  aria-label={`Download ${current.filename}`}
                >
                  <Download size={16} />
                </a>
                <DialogPrimitive.Close
                  className={iconButton}
                  title="Close"
                  aria-label="Close"
                >
                  <X size={16} />
                </DialogPrimitive.Close>
              </div>

              {/* Clicking the empty area around the image closes, like Gmail. */}
              <div
                className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-6"
                onClick={(e) => {
                  if (e.target === e.currentTarget) onIndexChange(null);
                }}
              >
                {many && (
                  <button
                    type="button"
                    onClick={() => step(-1)}
                    className={cn(iconButton, "absolute left-4")}
                    aria-label="Previous image"
                  >
                    <ChevronLeft size={18} />
                  </button>
                )}
                <img
                  key={current.id}
                  src={inlineUrl(current)}
                  alt={current.filename}
                  className="max-h-full max-w-full rounded-[4px] object-contain shadow-2xl"
                />
                {many && (
                  <button
                    type="button"
                    onClick={() => step(1)}
                    className={cn(iconButton, "absolute right-4")}
                    aria-label="Next image"
                  >
                    <ChevronRight size={18} />
                  </button>
                )}
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
