/** Every part but the last is this size; R2 wants equal parts of at least 5 MiB. */
export const PART_BYTES = 5 * 1024 * 1024;

export interface WrittenPart {
  partNumber: number;
  etag: string;
  /** With `hash`: the part's size and hex SHA-256. */
  bytes?: number;
  sha256?: string;
}

/**
 * Fills parts of exactly PART_BYTES of an R2 multipart upload and uploads
 * each as soon as it is full, so a job holds one part at a time. What does
 * not fill a part is `rest()`: the caller carries it to its next step, or
 * makes it the last part.
 */
export class PartWriter {
  private buffer = new Uint8Array(PART_BYTES);
  private length = 0;

  constructor(
    private upload: R2MultipartUpload,
    readonly parts: WrittenPart[],
    private hash = false,
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(PART_BYTES - this.length, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + take), this.length);
      this.length += take;
      offset += take;
      if (this.length === PART_BYTES) {
        const sha256 = this.hash ? await hexDigest(this.buffer) : undefined;
        const part = await this.upload.uploadPart(
          this.parts.length + 1,
          this.buffer,
        );
        this.parts.push({
          partNumber: part.partNumber,
          etag: part.etag,
          ...(sha256 ? { bytes: PART_BYTES, sha256 } : {}),
        });
        this.length = 0;
      }
    }
  }

  /** What did not fill a part. */
  rest(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

async function hexDigest(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
