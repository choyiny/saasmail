import { and, eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { htmlToText } from "../lib/html-to-text";
import { isInboxAllowed, type AllowedInboxes } from "../lib/inbox-permissions";
import {
  publicBodyPartBlobId,
  publicRawBlobId,
  publicThreadId,
} from "./public-ids";

export type ContentAddress = { name: string | null; email: string };

export type ContentLeaf = {
  /** "1", "2", … in depth-first order. */
  partId: string;
  /** Lowercased media type. */
  type: string;
  /** "utf-8" for text leaves, null otherwise. */
  charset: string | null;
  name: string | null;
  disposition: "attachment" | "inline" | null;
  /** Without angle brackets. */
  cid: string | null;
  /** Decoded octets. */
  size: number;
  /** Content-owned R2 copy; null for text leaves (value in body_values_json). */
  r2Key: string | null;
};

export type ContentMultipart = {
  partId: null;
  type: "multipart/mixed" | "multipart/alternative" | "multipart/related";
  subParts: ContentPart[];
};

export type ContentPart = ContentLeaf | ContentMultipart;

export type JmapContentRow = typeof jmapMessageContent.$inferSelect;

export type BodyLists = {
  textBody: string[];
  htmlBody: string[];
  attachments: string[];
};

export function isMultipart(part: ContentPart): part is ContentMultipart {
  return part.partId === null;
}

/** Leaves in depth-first order (the order part ids were assigned in). */
export function contentLeaves(part: ContentPart): ContentLeaf[] {
  if (isMultipart(part)) return part.subParts.flatMap(contentLeaves);
  return [part as ContentLeaf];
}

export function toCrlf(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function isInlineMediaType(type: string): boolean {
  return (
    type.startsWith("image/") ||
    type.startsWith("audio/") ||
    type.startsWith("video/")
  );
}

/**
 * RFC 8621 §4.1.4 `parseStructure`, transcribed. `textBody`/`htmlBody` become
 * null inside multipart/alternative once the other flavour is chosen, exactly
 * as in the RFC's pseudocode.
 */
function parseStructure(
  parts: ContentPart[],
  multipartType: string,
  inAlternative: boolean,
  htmlBody: ContentLeaf[] | null,
  textBody: ContentLeaf[] | null,
  attachments: ContentLeaf[],
): void {
  const textLength = textBody ? textBody.length : -1;
  const htmlLength = htmlBody ? htmlBody.length : -1;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (isMultipart(part)) {
      const subMultiType = part.type.split("/")[1];
      parseStructure(
        part.subParts,
        subMultiType,
        inAlternative || subMultiType === "alternative",
        htmlBody,
        textBody,
        attachments,
      );
      continue;
    }
    const leaf = part as ContentLeaf;
    const isInline =
      leaf.disposition !== "attachment" &&
      (leaf.type === "text/plain" ||
        leaf.type === "text/html" ||
        isInlineMediaType(leaf.type)) &&
      (i === 0 ||
        (multipartType !== "related" &&
          (isInlineMediaType(leaf.type) || !leaf.name)));

    if (!isInline) {
      attachments.push(leaf);
      continue;
    }
    if (multipartType === "alternative") {
      if (leaf.type === "text/plain") {
        if (textBody) textBody.push(leaf);
      } else if (leaf.type === "text/html") {
        if (htmlBody) htmlBody.push(leaf);
      } else {
        attachments.push(leaf);
      }
      continue;
    }
    if (inAlternative) {
      if (leaf.type === "text/plain") htmlBody = null;
      if (leaf.type === "text/html") textBody = null;
    }
    if (textBody) textBody.push(leaf);
    if (htmlBody) htmlBody.push(leaf);
    if ((!textBody || !htmlBody) && isInlineMediaType(leaf.type)) {
      attachments.push(leaf);
    }
  }

  if (multipartType === "alternative" && textBody && htmlBody) {
    // Found HTML part only
    if (textLength === textBody.length && htmlLength !== htmlBody.length) {
      for (let i = htmlLength; i < htmlBody.length; i += 1) {
        textBody.push(htmlBody[i]);
      }
    }
    // Found plaintext part only
    if (htmlLength === htmlBody.length && textLength !== textBody.length) {
      for (let i = textLength; i < textBody.length; i += 1) {
        htmlBody.push(textBody[i]);
      }
    }
  }
}

export function deriveBodyLists(root: ContentPart): BodyLists {
  const textBody: ContentLeaf[] = [];
  const htmlBody: ContentLeaf[] = [];
  const attachments: ContentLeaf[] = [];
  parseStructure([root], "mixed", false, htmlBody, textBody, attachments);
  const ids = (parts: ContentLeaf[]) => parts.map((part) => part.partId);
  return {
    textBody: ids(textBody),
    htmlBody: ids(htmlBody),
    attachments: ids(attachments),
  };
}

/** RFC 8621 `preview`: up to 256 characters of plain text. */
export function contentPreview(
  root: ContentPart,
  bodyValues: Record<string, string>,
  lists: BodyLists,
): string {
  const leaves = new Map(
    contentLeaves(root).map((leaf) => [leaf.partId, leaf]),
  );
  const first = (ids: string[], type: string) =>
    ids
      .map((id) => leaves.get(id))
      .find(
        (leaf) =>
          leaf !== undefined &&
          leaf.type === type &&
          bodyValues[leaf.partId] !== undefined,
      );
  const text = first(lists.textBody, "text/plain");
  const html = first(lists.htmlBody, "text/html");
  const source = text
    ? bodyValues[text.partId]
    : html
      ? htmlToText(bodyValues[html.partId])
      : "";
  return source.replace(/\s+/g, " ").trim().slice(0, 256);
}

/** RFC 8621 §4.4 `properties`: null selects every supported property. */
export function selectEmailProperties(
  full: Record<string, unknown>,
  properties: unknown,
): Record<string, unknown> | null {
  if (properties === undefined || properties === null) return full;
  if (
    !Array.isArray(properties) ||
    !properties.every((property) => typeof property === "string")
  ) {
    return null;
  }
  const selected: Record<string, unknown> = { id: full.id };
  for (const property of properties as string[]) {
    selected[property] = property in full ? full[property] : null;
  }
  return selected;
}

function utcSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { value: string; isTruncated: boolean } {
  if (maxBytes <= 0) return { value, isTruncated: false };
  const bytes = utf8Bytes(value);
  if (bytes.byteLength <= maxBytes) return { value, isTruncated: false };
  let end = maxBytes;
  // Never cut inside a UTF-8 sequence: back up over continuation bytes.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: new TextDecoder().decode(bytes.subarray(0, end)),
    isTruncated: true,
  };
}

function addresses(json: string | null): ContentAddress[] | null {
  if (json === null) return null;
  const list = JSON.parse(json) as ContentAddress[];
  return list.length > 0 ? list : null;
}

/** Immutable RFC 8621 Email properties of a content row, for any Email backed by it. */
export function contentEmailObject(
  content: JmapContentRow,
  view: {
    id: string;
    mailboxIds: Record<string, true>;
    keywords: Record<string, true>;
    receivedAt: number;
  },
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const root = JSON.parse(content.partsJson) as ContentPart;
  const leaves = new Map(
    contentLeaves(root).map((leaf) => [leaf.partId, leaf]),
  );
  const values = JSON.parse(content.bodyValuesJson) as Record<string, string>;
  const textIds = JSON.parse(content.textBodyJson) as string[];
  const htmlIds = JSON.parse(content.htmlBodyJson) as string[];
  const attachmentIds = JSON.parse(content.attachmentsJson) as string[];

  const partObject = (part: ContentPart): Record<string, unknown> => {
    if (isMultipart(part)) {
      const subParts = part.subParts.map(partObject);
      return {
        partId: null,
        blobId: null,
        size: subParts.reduce((sum, sub) => sum + (sub.size as number), 0),
        name: null,
        type: part.type,
        charset: null,
        disposition: null,
        cid: null,
        language: null,
        location: null,
        subParts,
      };
    }
    const leaf = part as ContentLeaf;
    return {
      partId: leaf.partId,
      blobId: publicBodyPartBlobId(view.id, leaf.partId),
      size: leaf.size,
      name: leaf.name,
      type: leaf.type,
      charset: leaf.charset,
      disposition: leaf.disposition,
      cid: leaf.cid,
      language: null,
      location: null,
    };
  };
  const leafObject = (partId: string) => partObject(leaves.get(partId)!);

  const wanted = new Set<string>();
  if (args.fetchTextBodyValues === true)
    textIds.forEach((id) => wanted.add(id));
  if (args.fetchHTMLBodyValues === true)
    htmlIds.forEach((id) => wanted.add(id));
  if (args.fetchAllBodyValues === true) {
    for (const leaf of leaves.values()) {
      if (leaf.type.startsWith("text/")) wanted.add(leaf.partId);
    }
  }
  const maxBytes =
    typeof args.maxBodyValueBytes === "number" && args.maxBodyValueBytes > 0
      ? args.maxBodyValueBytes
      : 0;
  const bodyValues: Record<string, unknown> = {};
  for (const partId of wanted) {
    const value = values[partId];
    if (value === undefined) continue;
    const truncated = truncateUtf8(value, maxBytes);
    bodyValues[partId] = {
      value: truncated.value,
      isEncodingProblem: false,
      isTruncated: truncated.isTruncated,
    };
  }

  const full: Record<string, unknown> = {
    id: view.id,
    blobId: publicRawBlobId(content.id),
    threadId: publicThreadId(content.threadKey),
    mailboxIds: view.mailboxIds,
    keywords: view.keywords,
    size: content.size,
    receivedAt: utcSeconds(view.receivedAt),
    messageId: [content.messageId],
    inReplyTo: content.inReplyToJson ? JSON.parse(content.inReplyToJson) : null,
    references: content.referencesJson
      ? JSON.parse(content.referencesJson)
      : null,
    sender: null,
    from: JSON.parse(content.fromJson),
    to: addresses(content.toJson),
    cc: addresses(content.ccJson),
    bcc: addresses(content.bccJson),
    replyTo: addresses(content.replyToJson),
    subject: content.subject,
    sentAt: content.sentAt,
    hasAttachment: attachmentIds.length > 0,
    preview: content.preview,
    bodyValues,
    textBody: textIds.map(leafObject),
    htmlBody: htmlIds.map(leafObject),
    attachments: attachmentIds.map(leafObject),
    bodyStructure: partObject(root),
    headers: null,
  };
  return selectEmailProperties(full, args.properties);
}

export const CONTENT_GC_GRACE_SECONDS = 3600;
const CONTENT_GC_LIMIT = 200;

/**
 * Content is referenced while something shows it: a draft, a JMAP-sent Sent row
 * (aliased or not), or a submission that is in flight (`claimed`) or whose
 * on-success step has not run yet (`pending` — its patch still names the
 * Email). Keep every reference in this one predicate — a missing one makes the
 * hourly GC delete content a Sent Email still shows.
 */
function contentReferencedSql(contentId: SQL): SQL {
  return sql`(
    EXISTS (SELECT 1 FROM jmap_drafts d WHERE d.content_id = ${contentId})
    OR EXISTS (
      SELECT 1 FROM sent_emails se WHERE se.jmap_content_id = ${contentId}
    )
    OR EXISTS (
      SELECT 1 FROM jmap_submissions js
       WHERE js.content_id = ${contentId}
         AND (js.attempt_state = 'claimed' OR js.on_success_state = 'pending')
    )
  )`;
}

function contentObjectKeys(rawR2Key: string, partsJson: string): string[] {
  const leaves = contentLeaves(JSON.parse(partsJson) as ContentPart);
  return [
    rawR2Key,
    ...leaves
      .map((leaf) => leaf.r2Key)
      .filter((key): key is string => key !== null),
  ];
}

/** Delete one content row if nothing references it: R2 objects first, then the row (spec §10.3). */
export async function deleteContentIfUnreferenced(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: DrizzleD1Database<any>,
  env: CloudflareBindings,
  contentId: string,
): Promise<boolean> {
  const rows = await db.all<{ raw_r2_key: string; parts_json: string }>(sql`
    SELECT c.raw_r2_key, c.parts_json FROM jmap_message_content c
     WHERE c.id = ${contentId} AND NOT ${contentReferencedSql(sql`c.id`)}
  `);
  const row = rows[0];
  if (!row) return false;
  await env.R2.delete(contentObjectKeys(row.raw_r2_key, row.parts_json));
  await db.run(sql`
    DELETE FROM jmap_message_content
     WHERE id = ${contentId} AND NOT ${contentReferencedSql(sql`jmap_message_content.id`)}
  `);
  return true;
}

/** Cron: unreferenced content older than the grace period (never an in-progress create). */
export async function collectUnreferencedContent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: DrizzleD1Database<any>,
  env: CloudflareBindings,
  now: number,
  graceSeconds = CONTENT_GC_GRACE_SECONDS,
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    SELECT c.id AS id FROM jmap_message_content c
     WHERE c.created_at < ${now - graceSeconds}
       AND NOT ${contentReferencedSql(sql`c.id`)}
     LIMIT ${CONTENT_GC_LIMIT}
  `);
  let removed = 0;
  for (const row of rows) {
    if (await deleteContentIfUnreferenced(db, env, row.id)) removed += 1;
  }
  return removed;
}

/**
 * Content the caller may read: their own draft on it, in an allowed inbox.
 * PR 5 adds content read through a visible Sent row.
 */
export async function findReadableContent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  contentId: string,
): Promise<JmapContentRow | null> {
  const rows = await db
    .select({ content: jmapMessageContent, inbox: jmapDrafts.inbox })
    .from(jmapDrafts)
    .innerJoin(
      jmapMessageContent,
      eq(jmapMessageContent.id, jmapDrafts.contentId),
    )
    .where(
      and(eq(jmapDrafts.userId, userId), eq(jmapDrafts.contentId, contentId)),
    )
    .limit(1);
  const row = rows[0];
  return row && isInboxAllowed(allowed, row.inbox) ? row.content : null;
}
