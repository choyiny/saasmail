/**
 * Identify an image and read its dimensions from the file header.
 *
 * Two jobs, one pass, deliberately:
 *
 *   1. **The format check.** A newsletter asset is served publicly from the
 *      application's own origin, so "is this really a PNG" is a security
 *      question, not a convenience one. The answer must come from the bytes —
 *      a client-declared `Content-Type` and a filename extension are both
 *      attacker-controlled.
 *   2. **The dimensions.** Correct `width`/`height` attributes measurably
 *      reduce layout shift in webmail, and `sharp` does not run on Workers.
 *
 * SVG is absent from this list on purpose: it is an XML document that can carry
 * script, and no newsletter needs one.
 */

export type ImageInfo = {
  contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
};

const ascii = (b: Uint8Array, at: number, text: string): boolean => {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (b[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(b: Uint8Array): ImageInfo | null {
  if (b.length < 24) return null;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (b[i] !== PNG_MAGIC[i]) return null;
  }
  // The first chunk must be IHDR; anything else is not a well-formed PNG.
  if (!ascii(b, 12, "IHDR")) return null;
  return {
    contentType: "image/png",
    width: u32be(b, 16),
    height: u32be(b, 20),
  };
}

function readGif(b: Uint8Array): ImageInfo | null {
  if (b.length < 10) return null;
  if (!ascii(b, 0, "GIF87a") && !ascii(b, 0, "GIF89a")) return null;
  return {
    contentType: "image/gif",
    width: u16le(b, 6),
    height: u16le(b, 8),
  };
}

function readWebp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30) return null;
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;

  // Lossy: the VP8 keyframe header carries 14-bit dimensions.
  if (ascii(b, 12, "VP8 ")) {
    return {
      contentType: "image/webp",
      width: u16le(b, 26) & 0x3fff,
      height: u16le(b, 28) & 0x3fff,
    };
  }
  // Lossless: 14 bits of (width-1) then 14 bits of (height-1), little-endian.
  if (ascii(b, 12, "VP8L")) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return {
      contentType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  // Extended: 24-bit canvas dimensions, each stored as value-1.
  if (ascii(b, 12, "VP8X")) {
    return {
      contentType: "image/webp",
      width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
      height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
    };
  }
  return null;
}

/**
 * JPEG keeps its dimensions in a Start-Of-Frame segment, which sits an
 * unbounded number of segments into the file (EXIF thumbnails and colour
 * profiles come first). Walk the segment chain rather than guessing an offset.
 */
function readJpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;

  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) {
      at++; // Resynchronise across fill bytes rather than giving up.
      continue;
    }
    const marker = b[at + 1];
    // Standalone markers carry no length payload.
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      at += 2;
      continue;
    }
    // SOS means the entropy-coded scan begins; no SOF was found before it.
    if (marker === 0xda) return null;

    const length = u16be(b, at + 2);
    if (length < 2) return null;

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof) {
      return {
        contentType: "image/jpeg",
        height: u16be(b, at + 5),
        width: u16be(b, at + 7),
      };
    }
    at += 2 + length;
  }
  return null;
}

/**
 * Return the format and dimensions, or null if the bytes are not one of the
 * four permitted formats. A null answer is the allowlist failing closed: the
 * upload is refused rather than stored with a guessed type.
 */
export function readImageHeader(bytes: Uint8Array): ImageInfo | null {
  const info =
    readPng(bytes) ??
    readGif(bytes) ??
    readWebp(bytes) ??
    readJpeg(bytes) ??
    null;

  // A zero or absurd dimension means the header parsed but the file is not
  // usable; treat it as a rejection rather than storing a broken asset.
  if (!info) return null;
  if (info.width <= 0 || info.height <= 0) return null;
  if (info.width > 20_000 || info.height > 20_000) return null;
  return info;
}
