import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jmapBlobs } from "../db/jmap-blobs.schema";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { sanitizeFilename } from "../lib/sanitize-filename";
import { findReadableAttachment } from "../routers/attachments-router";
import { parseAttachmentBlobId, parseUploadBlobId } from "./public-ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export type ResolvedBlob = {
  /** The public id as requested. */
  blobId: string;
  type: string;
  /** Octets. */
  size: number;
  name: string | null;
  source: { r2Key: string } | { bytes: Uint8Array };
};

/**
 * The one place that decides whether a caller may read a blob, for every
 * family the server serves. Unknown or malformed ids resolve to null, never
 * throw. PR 4 adds raw-message (X…) and body-part (P…) blocks.
 */
export async function resolveReadableBlob(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  blobId: string,
): Promise<ResolvedBlob | null> {
  const uploadId = parseUploadBlobId(blobId);
  if (uploadId !== null) {
    // RFC 8620 §6.1: an unreferenced blob is readable only by its uploader.
    const rows = await db
      .select()
      .from(jmapBlobs)
      .where(and(eq(jmapBlobs.id, uploadId), eq(jmapBlobs.userId, userId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      blobId,
      type: row.type,
      size: row.size,
      name: null,
      source: { r2Key: row.r2Key },
    };
  }

  const attachmentId = parseAttachmentBlobId(blobId);
  if (attachmentId !== null) {
    const attachment = await findReadableAttachment(db, allowed, attachmentId);
    if (!attachment) return null;
    return {
      blobId,
      type: attachment.contentType,
      size: attachment.size,
      name: attachment.filename,
      source: { r2Key: attachment.r2Key },
    };
  }

  return null;
}

/** The blob's bytes, or null when its R2 object is missing. */
export async function readBlobBytes(
  env: CloudflareBindings,
  blob: ResolvedBlob,
): Promise<Uint8Array | null> {
  // Strict mode is off: read the union through an explicit shape.
  const source = blob.source as { r2Key?: string; bytes?: Uint8Array };
  if (source.bytes) return source.bytes;
  const object = await env.R2.get(source.r2Key!);
  if (!object) return null;
  return new Uint8Array(await object.arrayBuffer());
}

/** RFC 8620 §6.2 `type`, unless it can't be a header value. */
export function downloadContentType(
  requested: string | undefined,
  fallback: string,
): string {
  const value = requested?.trim() ?? "";
  if (value.length === 0 || value.length > 255 || /[^\x20-\x7e]/.test(value)) {
    return fallback;
  }
  return value;
}

/** RFC 8620 §6.2 `name` (MUST be the filename), sanitised for the header. */
export function downloadFilename(
  requested: string | undefined,
  fallback: string | null,
): string {
  const name = requested && requested.length > 0 ? requested : fallback;
  if (!name) return "download";
  return sanitizeFilename(name).replaceAll('"', "_");
}
