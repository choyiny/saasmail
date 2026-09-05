import { describe, it, expect } from "vitest";
import { readImageHeader } from "../lib/image-header";

/**
 * The header parser is the allowlist for a publicly served, unauthenticated
 * endpoint. Its job is not "guess the format" — it is "prove the bytes are one
 * of four formats, or refuse". Every test below is written from that angle:
 * the interesting cases are the ones that must return null.
 */

const bytes = (...parts: (number[] | string)[]): Uint8Array => {
  const flat: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const ch of part) flat.push(ch.charCodeAt(0));
    } else {
      flat.push(...part);
    }
  }
  return new Uint8Array(flat);
};

const be32 = (n: number) => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const png = (w: number, h: number) =>
  bytes(PNG_SIG, be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0]);

const gif = (w: number, h: number) => bytes("GIF89a", le16(w), le16(h), [0, 0]);

const webpLossy = (w: number, h: number) =>
  bytes(
    "RIFF",
    be32(0),
    "WEBP",
    "VP8 ",
    be32(0),
    [0x9d, 0x01, 0x2a, 0, 0, 0], // frame tag + sync code, then dimensions
    le16(w),
    le16(h),
    [0, 0, 0, 0],
  );

/** JPEG with an APP0 segment ahead of the SOF0, as real files have. */
const jpeg = (w: number, h: number, leadingSegments = 1) => {
  const parts: (number[] | string)[] = [[0xff, 0xd8]];
  for (let i = 0; i < leadingSegments; i++) {
    parts.push([0xff, 0xe0], be16(6), [0, 0, 0, 0]);
  }
  parts.push([0xff, 0xc0], be16(11), [8], be16(h), be16(w), [3]);
  return bytes(...parts);
};

describe("recognises the four permitted formats", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(readImageHeader(png(600, 315))).toEqual({
      contentType: "image/png",
      width: 600,
      height: 315,
    });
  });

  it("reads GIF dimensions, which are little-endian", () => {
    expect(readImageHeader(gif(320, 240))).toEqual({
      contentType: "image/gif",
      width: 320,
      height: 240,
    });
  });

  it("reads lossy WebP dimensions, masking the 14-bit fields", () => {
    expect(readImageHeader(webpLossy(1024, 768))).toEqual({
      contentType: "image/webp",
      width: 1024,
      height: 768,
    });
  });

  it("reads JPEG dimensions from SOF0", () => {
    expect(readImageHeader(jpeg(800, 600))).toEqual({
      contentType: "image/jpeg",
      width: 800,
      height: 600,
    });
  });

  /**
   * A real JPEG puts EXIF and colour-profile segments before the frame header,
   * so the offset of SOF is not fixed. The parser walks the segment chain; this
   * is the test that would fail if someone replaced it with a constant offset.
   */
  it("finds SOF past a run of leading segments", () => {
    expect(readImageHeader(jpeg(800, 600, 12))).toMatchObject({
      width: 800,
      height: 600,
    });
  });
});

describe("refuses everything else", () => {
  it("refuses SVG, which is a scriptable document", () => {
    expect(
      readImageHeader(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    ).toBeNull();
  });

  it("refuses HTML", () => {
    expect(
      readImageHeader(bytes("<!doctype html><script>1</script>")),
    ).toBeNull();
  });

  it("refuses a PDF", () => {
    expect(readImageHeader(bytes("%PDF-1.7\n"))).toBeNull();
  });

  it("refuses empty and truncated input", () => {
    expect(readImageHeader(bytes())).toBeNull();
    expect(readImageHeader(bytes(PNG_SIG))).toBeNull();
    expect(readImageHeader(bytes([0xff, 0xd8]))).toBeNull();
  });

  /**
   * The whole point of sniffing: a file named `.png` and declared
   * `image/png` whose bytes are a script must not be stored as an image.
   */
  it("refuses HTML no matter what the caller claims it is", () => {
    expect(
      readImageHeader(bytes("GIF89", "<script>alert(1)</script>")),
    ).toBeNull();
  });

  it("refuses a PNG whose first chunk is not IHDR", () => {
    expect(
      readImageHeader(bytes(PNG_SIG, be32(13), "IDAT", be32(10), be32(10))),
    ).toBeNull();
  });

  it("refuses a RIFF container that is not WebP", () => {
    expect(
      readImageHeader(
        bytes("RIFF", be32(0), "WAVE", "fmt ", new Array(20).fill(0)),
      ),
    ).toBeNull();
  });

  it("refuses a JPEG whose scan starts before any frame header", () => {
    expect(
      readImageHeader(bytes([0xff, 0xd8], [0xff, 0xda], be16(6), [0, 0, 0, 0])),
    ).toBeNull();
  });
});

describe("rejects dimensions that cannot be real", () => {
  it("refuses a zero dimension", () => {
    expect(readImageHeader(png(0, 100))).toBeNull();
    expect(readImageHeader(gif(100, 0))).toBeNull();
  });

  it("refuses an absurd dimension rather than storing a decompression bomb", () => {
    expect(readImageHeader(png(50_000, 50_000))).toBeNull();
  });
});
