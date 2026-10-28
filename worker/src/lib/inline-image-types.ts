/**
 * Attachment types that may be shown inline: in an `<img>`, in the in-app
 * image viewer, or opened directly in a browser tab.
 *
 * Raster formats only, and deliberately an allowlist. An attachment's
 * Content-Type is whatever the SENDER wrote, and anything served inline comes
 * from the app's own origin — so `image/svg+xml` or `text/html` opened in a
 * tab would run the sender's script with the viewer's session. SVG is left
 * out for exactly that reason, even though it is "an image".
 *
 * Like `lib/gmail/error-codes.ts`, this module imports nothing, so the
 * frontend shares it through the `@worker/*` alias and the two cannot drift.
 */
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

/** Is this Content-Type (parameters and casing ignored) safe to show inline? */
export function isInlineImageType(contentType: string | null | undefined) {
  if (!contentType) return false;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return INLINE_IMAGE_TYPES.has(base);
}
