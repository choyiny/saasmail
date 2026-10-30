import { asc, eq, inArray, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { jmapBlobs } from "../db/jmap-blobs.schema";
import { problem } from "./auth";
import { publicUploadBlobId } from "./public-ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export type UploadInput = {
  userId: string;
  /** Public account id, echoed in the response. */
  accountId: string;
  contentType: string | null;
  /** Parsed Content-Length, or null when absent or malformed. */
  declaredLength: number | null;
  body: ReadableStream<Uint8Array> | null;
  maxBytes: number;
  now?: number;
};

export type UploadedBlob = {
  accountId: string;
  blobId: string;
  type: string;
  size: number;
};

/** Strict mode is off in the worker, so no discriminated union: check the nullable fields. */
export type UploadResult = {
  blob: UploadedBlob | null;
  /** Set (to the limit) when the body is larger than allowed; blob is then null. */
  tooLargeLimit: number | null;
};

/**
 * Read the whole body, giving up as soon as it passes maxBytes. The declared
 * Content-Length can be absent (chunked) or wrong, so only this counter is
 * authoritative.
 */
export async function readCappedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The media type as sent (RFC 8620 §6.1), or octet-stream when unusable as a header value. */
export function uploadMediaType(header: string | null): string {
  const value = header?.trim() ?? "";
  if (value.length === 0 || value.length > 255 || /[^\x20-\x7e]/.test(value)) {
    return "application/octet-stream";
  }
  return value;
}

export function parseDeclaredLength(
  header: string | null | undefined,
): number | null {
  if (!header) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function uploadTooLargeProblem(maxBytes: number): Response {
  return problem(
    413,
    "about:blank",
    "Payload Too Large",
    `Uploads are limited to ${maxBytes} octets.`,
    { limit: "maxSizeUpload", maxSize: maxBytes },
  );
}

/**
 * Store one upload. D1 first, then R2 (spec §10.3): a crash between the two
 * leaves a row whose object is missing, which the 24-hour reaper removes.
 * If the R2 write fails, the object is deleted (it may exist if only the
 * response failed) and then the row, so nothing untracked is left behind.
 */
export async function storeUpload(
  db: Db,
  env: CloudflareBindings,
  input: UploadInput,
): Promise<UploadResult> {
  if (input.declaredLength !== null && input.declaredLength > input.maxBytes) {
    return { blob: null, tooLargeLimit: input.maxBytes };
  }
  const bytes = await readCappedBody(input.body, input.maxBytes);
  if (bytes === null) return { blob: null, tooLargeLimit: input.maxBytes };

  const id = nanoid();
  const type = uploadMediaType(input.contentType);
  const r2Key = `jmap-uploads/${input.userId}/${id}`;
  const now = input.now ?? Math.floor(Date.now() / 1000);

  await db.insert(jmapBlobs).values({
    id,
    userId: input.userId,
    type,
    size: bytes.byteLength,
    r2Key,
    createdAt: now,
  });
  try {
    await env.R2.put(r2Key, bytes, { httpMetadata: { contentType: type } });
  } catch (err) {
    await env.R2.delete(r2Key).catch(() => undefined);
    await db.delete(jmapBlobs).where(eq(jmapBlobs.id, id));
    throw err;
  }

  return {
    blob: {
      accountId: input.accountId,
      blobId: publicUploadBlobId(id),
      type,
      size: bytes.byteLength,
    },
    tooLargeLimit: null,
  };
}

/** Uploads live this long. Drafts copy the bytes they keep (PR 4). */
export const UPLOAD_TTL_SECONDS = 24 * 60 * 60;
const UPLOAD_REAP_LIMIT = 500;
/** D1 binds at most 100 parameters per statement. */
const D1_ID_CHUNK = 90;

/**
 * Hourly: delete uploads older than the TTL. R2 objects first, then rows
 * (spec §10.3), so a crash in between leaves rows the next run retries,
 * never untracked objects. Bounded per run; the backlog drains hourly.
 */
export async function reapExpiredUploads(
  db: Db,
  env: CloudflareBindings,
  now: number,
  ttlSeconds = UPLOAD_TTL_SECONDS,
): Promise<number> {
  const expired = await db
    .select({ id: jmapBlobs.id, r2Key: jmapBlobs.r2Key })
    .from(jmapBlobs)
    .where(lt(jmapBlobs.createdAt, now - ttlSeconds))
    .orderBy(asc(jmapBlobs.createdAt))
    .limit(UPLOAD_REAP_LIMIT);
  if (expired.length === 0) return 0;

  await env.R2.delete(expired.map((row) => row.r2Key));
  for (let start = 0; start < expired.length; start += D1_ID_CHUNK) {
    await db.delete(jmapBlobs).where(
      inArray(
        jmapBlobs.id,
        expired.slice(start, start + D1_ID_CHUNK).map((row) => row.id),
      ),
    );
  }
  return expired.length;
}
