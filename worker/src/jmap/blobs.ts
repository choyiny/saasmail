import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jmapBlobs } from "../db/jmap-blobs.schema";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { sanitizeFilename } from "../lib/sanitize-filename";
import { findReadableAttachment } from "../routers/attachments-router";
import {
  contentLeaves,
  findReadableContent,
  toCrlf,
  utf8Bytes,
  type ContentPart,
} from "./content";
import { loadDraftsByIds } from "./drafts";
import { loadJmapEmailObjectsByIds } from "./emails";
import {
  parseAnyEmailId,
  parseAttachmentBlobId,
  parseBodyPartBlobId,
  parseRawBlobId,
  parseUploadBlobId,
} from "./public-ids";

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

async function resolveRawMessageBlob(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  blobId: string,
  contentId: string,
): Promise<ResolvedBlob | null> {
  const content = await findReadableContent(db, allowed, userId, contentId);
  if (!content) return null;
  return {
    blobId,
    type: "message/rfc822",
    size: content.size,
    name: null,
    source: { r2Key: content.rawR2Key },
  };
}

async function resolveBodyPartBlob(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  blobId: string,
  target: { emailId: string; part: string },
): Promise<ResolvedBlob | null> {
  const ref = parseAnyEmailId(target.emailId);
  if (!ref) return null;

  if (ref.kind === "draft") {
    const item = (await loadDraftsByIds(db, allowed, userId, [ref.id])).get(
      ref.id,
    );
    if (!item) return null;
    const leaf = contentLeaves(
      JSON.parse(item.content.partsJson) as ContentPart,
    ).find((candidate) => candidate.partId === target.part);
    if (!leaf) return null;
    if (leaf.r2Key !== null) {
      return {
        blobId,
        type: leaf.type,
        size: leaf.size,
        name: leaf.name,
        source: { r2Key: leaf.r2Key },
      };
    }
    const value = (
      JSON.parse(item.content.bodyValuesJson) as Record<string, string>
    )[leaf.partId];
    if (value === undefined) return null;
    const bytes = utf8Bytes(toCrlf(value));
    return {
      blobId,
      type: leaf.type,
      size: bytes.byteLength,
      name: leaf.name,
      source: { bytes },
    };
  }

  // Received and sent mail expose two synthetic parts: "text" and "html".
  if (target.part !== "text" && target.part !== "html") return null;
  const message = (
    await loadJmapEmailObjectsByIds(db, allowed, userId, [target.emailId])
  ).get(target.emailId);
  const value = target.part === "text" ? message?.bodyText : message?.bodyHtml;
  if (value === undefined || value === null) return null;
  const bytes = utf8Bytes(value);
  return {
    blobId,
    type: target.part === "text" ? "text/plain" : "text/html",
    size: bytes.byteLength,
    name: null,
    source: { bytes },
  };
}

/**
 * The one place that decides whether a caller may read a blob, for every
 * family the server serves. Unknown or malformed ids resolve to null, never
 * throw. Raw-message (X…) and body-part (P…) ids need PR 4's content rows.
 */
export async function resolveReadableBlob(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  blobId: string,
): Promise<ResolvedBlob | null> {
  const rawContentId = parseRawBlobId(blobId);
  if (rawContentId !== null) {
    return resolveRawMessageBlob(db, allowed, userId, blobId, rawContentId);
  }
  const bodyPart = parseBodyPartBlobId(blobId);
  if (bodyPart !== null) {
    return resolveBodyPartBlob(db, allowed, userId, blobId, bodyPart);
  }

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
