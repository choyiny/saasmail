import type { DrizzleD1Database } from "drizzle-orm/d1";
import PostalMime, { type Address } from "postal-mime";
import { createEmailSender } from "../lib/email-sender";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { MAX_SEND_ATTACHMENTS } from "../lib/send-limits";
import { readBlobBytes, resolveReadableBlob } from "./blobs";
import { MAX_OBJECTS_IN_SET } from "./constants";
import { parseJmapDate } from "./dates";
import {
  createDraftEmail,
  Rejection,
  type InternalBlob,
  type SetError,
} from "./email-create";
import type { JmapMethodError } from "./emails";
import {
  isSystemDescriptor,
  listUsableIdentities,
  loadMailboxDescriptors,
  type MailboxDescriptor,
} from "./mailboxes";
import type { JmapMethodContext } from "./methods";
import { currentJmapState, parseJmapState } from "./state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** Bounds on the raw MIME tree an import walks (spec §1 step 2). */
export const MAX_IMPORT_PARTS = 100;
export const MAX_IMPORT_DEPTH = 10;

/** The last References ids kept; older ones are dropped (RFC 5322 §3.6.4 lets a reply trim them). */
const MAX_IMPORT_REFERENCES = 100;

const IMPORT_PROPERTIES = new Set([
  "blobId",
  "mailboxIds",
  "keywords",
  "receivedAt",
]);

/** Parts that mean the message is signed or encrypted; import refuses them. */
const REFUSED_TYPES = new Set([
  "multipart/signed",
  "multipart/encrypted",
  "application/pkcs7-mime",
  "application/x-pkcs7-mime",
  "application/pgp-encrypted",
]);

const ONLY_DRAFTS: SetError = {
  type: "forbidden",
  description: "Email/import only creates drafts",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Raw MIME structure scan. postal-mime flattens the tree (and concatenates
// every inline text part into one body), so the structure is read here, from
// the raw bytes, before anything is converted.
// ---------------------------------------------------------------------------

type ScannedHeaders = {
  /** Lowercased name -> first value, unfolded. */
  fields: Map<string, string>;
  /** Lowercased names that appear more than once. */
  repeated: Set<string>;
  bodyStart: number;
};

/** One leaf of the raw tree, as offsets into the message's bytes. */
export type ScannedLeaf = {
  /** Start of the part's headers. */
  start: number;
  bodyStart: number;
  end: number;
  /** Lowercased media type, without parameters. */
  type: string;
  /** Lowercased Content-Disposition value, or null. */
  disposition: string | null;
  /** Content-ID without angle brackets, or null. */
  cid: string | null;
  /** Lowercased Content-Transfer-Encoding, or null. */
  encoding: string | null;
  /** Inside a multipart/related. */
  inRelated: boolean;
  /** The type came from multipart/digest's default, not a header. */
  digestDefault: boolean;
};

export type MimeScan = {
  /** A description of why the message can't be imported, or null. */
  error: string | null;
  /** The top-level header block. */
  headerEnd: number;
  /** The first inline text/plain and text/html parts, if any. */
  textLeaf: ScannedLeaf | null;
  htmlLeaf: ScannedLeaf | null;
  /** Every other leaf: attachments and inline parts, in order. */
  attachmentLeaves: ScannedLeaf[];
};

/** Bytes to a string with one char per byte, so indices are byte offsets. */
function binaryString(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(
      String.fromCharCode(
        ...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)),
      ),
    );
  }
  return chunks.join("");
}

/**
 * Headers an entity may carry once. Content-Disposition is included because
 * it decides body versus attachment here and in postal-mime alike.
 */
const SINGLE_HEADERS = [
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
] as const;
const HEADER_LABELS: Record<(typeof SINGLE_HEADERS)[number], string> = {
  "content-type": "Content-Type",
  "content-transfer-encoding": "Content-Transfer-Encoding",
  "content-disposition": "Content-Disposition",
};

const TRANSFER_ENCODINGS = new Set([
  "7bit",
  "8bit",
  "binary",
  "base64",
  "quoted-printable",
]);

/**
 * The Content-Transfer-Encoding token exactly as postal-mime reads it (the
 * value with whitespace collapsed and trimmed, lowercased, up to the first
 * character that is neither a word character nor "-"), so both decode a part
 * the same way: "base64 (x)" is base64.
 */
export function transferEncodingToken(value: string): string {
  return (
    value
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .split(/[^\w-]/)
      .shift() ?? ""
  );
}

/** Drop RFC 822 comments, "(…)" with nesting, outside quoted strings. */
export function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "\\" && (quoted || depth > 0)) {
      if (depth === 0) out += char + (value[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (depth === 0 && char === '"') quoted = !quoted;
    if (!quoted && char === "(") {
      depth += 1;
      continue;
    }
    if (!quoted && char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
}

function scanHeaders(text: string, start: number, end: number): ScannedHeaders {
  const fields = new Map<string, string>();
  const repeated = new Set<string>();
  let current: { name: string; value: string } | null = null;
  const commit = () => {
    if (current && fields.has(current.name)) repeated.add(current.name);
    else if (current) fields.set(current.name, current.value.trim());
    current = null;
  };
  let pos = start;
  while (pos < end) {
    let newline = text.indexOf("\n", pos);
    if (newline === -1 || newline >= end) newline = end;
    let line = text.slice(pos, newline);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const next = Math.min(newline + 1, end);
    if (line.length === 0) {
      commit();
      return { fields, repeated, bodyStart: next };
    }
    if ((line[0] === " " || line[0] === "\t") && current) {
      (current as { value: string }).value += ` ${line.trim()}`;
    } else {
      commit();
      const colon = line.indexOf(":");
      if (colon > 0) {
        current = {
          name: line.slice(0, colon).trim().toLowerCase(),
          value: line.slice(colon + 1),
        };
      }
    }
    pos = next;
  }
  commit();
  return { fields, repeated, bodyStart: end };
}

/** "type/subtype; a=b; c="d"" -> the lowercased value and its parameters. */
export function parseHeaderValue(raw: string): {
  value: string;
  params: Map<string, string>;
  /** Parameter names given more than once (`x` and `x*` count as one). */
  repeated: string[];
} {
  // "multipart/signed(x); …" is multipart/signed (RFC 2045 §5.1 allows comments).
  const value = stripComments(raw);
  const params = new Map<string, string>();
  const seen = new Set<string>();
  const repeated: string[] = [];
  const semicolon = value.indexOf(";");
  const head = (semicolon === -1 ? value : value.slice(0, semicolon))
    .trim()
    .toLowerCase();
  let pos = semicolon === -1 ? value.length : semicolon + 1;
  while (pos < value.length) {
    const equals = value.indexOf("=", pos);
    if (equals === -1) break;
    const name = value.slice(pos, equals).trim().toLowerCase();
    pos = equals + 1;
    while (pos < value.length && (value[pos] === " " || value[pos] === "\t")) {
      pos += 1;
    }
    let paramValue = "";
    if (value[pos] === '"') {
      pos += 1;
      while (pos < value.length && value[pos] !== '"') {
        if (value[pos] === "\\" && pos + 1 < value.length) pos += 1;
        paramValue += value[pos];
        pos += 1;
      }
      const after = value.indexOf(";", pos);
      pos = after === -1 ? value.length : after + 1;
    } else {
      const after = value.indexOf(";", pos);
      paramValue = value.slice(pos, after === -1 ? value.length : after).trim();
      pos = after === -1 ? value.length : after + 1;
    }
    const base = name.replace(/\*$/, "");
    if (base.length > 0 && seen.has(base)) repeated.push(base);
    seen.add(base);
    if (name.length > 0 && !params.has(name)) params.set(name, paramValue);
  }
  return { value: head, params, repeated };
}

/** The body ranges of a multipart's parts, between its boundary lines. */
function splitMultipart(
  text: string,
  bodyStart: number,
  end: number,
  boundary: string,
): [number, number][] {
  const delimiter = `--${boundary}`;
  const parts: [number, number][] = [];
  let partStart = -1;
  let pos = bodyStart;
  while (pos < end) {
    let newline = text.indexOf("\n", pos);
    if (newline === -1 || newline >= end) newline = end;
    if (text.startsWith(delimiter, pos)) {
      let rest = text.slice(pos + delimiter.length, newline);
      if (rest.endsWith("\r")) rest = rest.slice(0, -1);
      const closing = rest.startsWith("--");
      if (/^[ \t]*$/.test(closing ? rest.slice(2) : rest)) {
        if (partStart !== -1) {
          // The line break before a delimiter belongs to the delimiter.
          let partEnd = pos;
          if (partEnd > partStart && text[partEnd - 1] === "\n") partEnd -= 1;
          if (partEnd > partStart && text[partEnd - 1] === "\r") partEnd -= 1;
          parts.push([partStart, Math.max(partStart, partEnd)]);
        }
        if (closing) return parts;
        partStart = Math.min(newline + 1, end);
      }
    }
    pos = newline + 1;
  }
  if (partStart !== -1) parts.push([partStart, end]);
  return parts;
}

function isBodyText(leaf: ScannedLeaf, type: string): boolean {
  return leaf.type === type && leaf.disposition !== "attachment";
}

/**
 * Walk the raw message's parts, bounded at MAX_IMPORT_PARTS parts and
 * MAX_IMPORT_DEPTH levels. A message/rfc822 part is a leaf: it is kept as an
 * attachment with its bytes intact, so its own parts are not this message's.
 */
export function scanMimeStructure(bytes: Uint8Array): MimeScan {
  const text = binaryString(bytes);
  const scan: MimeScan = {
    error: null,
    headerEnd: 0,
    textLeaf: null,
    htmlLeaf: null,
    attachmentLeaves: [],
  };
  let parts = 0;

  const walk = (
    start: number,
    end: number,
    depth: number,
    parentType: string | null,
    inRelated: boolean,
  ): string | null => {
    parts += 1;
    if (parts > MAX_IMPORT_PARTS) {
      return `The message has more than ${MAX_IMPORT_PARTS} MIME parts`;
    }
    if (depth > MAX_IMPORT_DEPTH) {
      return `The message's MIME parts nest deeper than ${MAX_IMPORT_DEPTH} levels`;
    }
    const headers = scanHeaders(text, start, end);
    if (depth === 1) scan.headerEnd = headers.bodyStart;
    // RFC 2045 allows one of each. This scanner and postal-mime would pick
    // different copies, so the structure checked here could differ from the
    // one converted: refuse rather than choose.
    for (const name of SINGLE_HEADERS) {
      if (headers.repeated.has(name)) {
        return `A MIME part has more than one ${HEADER_LABELS[name]} header`;
      }
    }
    const contentType = headers.fields.get("content-type");
    const parsedType = contentType ? parseHeaderValue(contentType) : null;
    const disposition = headers.fields.get("content-disposition");
    const parsedDisposition = disposition
      ? parseHeaderValue(disposition)
      : null;
    // postal-mime keeps the last of a repeated parameter and this parser the
    // first; a message that depends on which (two boundaries, say) is refused.
    for (const [label, parsed] of [
      ["Content-Type", parsedType],
      ["Content-Disposition", parsedDisposition],
    ] as const) {
      if (parsed && parsed.repeated.length > 0) {
        return `A ${label} header repeats its ${parsed.repeated[0]} parameter`;
      }
    }
    const rawEncoding = headers.fields.get("content-transfer-encoding");
    const encoding = rawEncoding ? transferEncodingToken(rawEncoding) : null;
    if (encoding !== null && !TRANSFER_ENCODINGS.has(encoding)) {
      return `Unsupported Content-Transfer-Encoding: ${rawEncoding}`;
    }
    const digestDefault =
      !parsedType?.value && parentType === "multipart/digest";
    const type =
      parsedType?.value || (digestDefault ? "message/rfc822" : "text/plain");
    if (REFUSED_TYPES.has(type)) {
      return `Signed or encrypted mail can't be imported (${type})`;
    }

    if (type.startsWith("multipart/")) {
      const boundary = parsedType?.params.get("boundary");
      if (!boundary) return `A ${type} part has no boundary`;
      const children = splitMultipart(text, headers.bodyStart, end, boundary);
      for (const [childStart, childEnd] of children) {
        const error = walk(
          childStart,
          childEnd,
          depth + 1,
          type,
          inRelated || type === "multipart/related",
        );
        if (error) return error;
      }
      return null;
    }

    const cid = headers.fields.get("content-id");
    const leaf: ScannedLeaf = {
      start,
      bodyStart: headers.bodyStart,
      end,
      type,
      disposition: parsedDisposition ? parsedDisposition.value : null,
      cid: cid ? cid.trim().replace(/^<(.*)>$/, "$1") || null : null,
      encoding,
      inRelated,
      digestDefault,
    };
    for (const [bodyType, slot] of [
      ["text/plain", "textLeaf"],
      ["text/html", "htmlLeaf"],
    ] as const) {
      if (isBodyText(leaf, bodyType)) {
        if (scan[slot]) {
          return `The message has more than one ${bodyType} body part; a draft keeps one`;
        }
        scan[slot] = leaf;
        return null;
      }
    }
    scan.attachmentLeaves.push(leaf);
    return null;
  };

  scan.error = walk(0, text.length, 1, null, false);
  return scan;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function isBase64Byte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2b ||
    byte === 0x2f
  );
}

function decodeBase64(body: Uint8Array): Uint8Array {
  // Line breaks, padding and anything else outside the alphabet are skipped.
  const alphabet = new Uint8Array(body.length);
  let count = 0;
  for (const byte of body) {
    if (isBase64Byte(byte)) alphabet[count++] = byte;
  }
  let clean = binaryString(alphabet.subarray(0, count));
  // Drop an impossible trailing sextet, then pad.
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  while (clean.length % 4 !== 0) clean += "=";
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const HEX = /^[0-9A-Fa-f]{2}$/;

function decodeQuotedPrintable(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length);
  let length = 0;
  for (let i = 0; i < body.length; i += 1) {
    const byte = body[i];
    if (byte !== 0x3d /* = */) {
      out[length++] = byte;
      continue;
    }
    // Soft line break: "=" then optional whitespace, then CRLF or LF.
    let j = i + 1;
    while (j < body.length && (body[j] === 0x20 || body[j] === 0x09)) j += 1;
    if (body[j] === 0x0d && body[j + 1] === 0x0a) {
      i = j + 1;
      continue;
    }
    if (body[j] === 0x0a) {
      i = j;
      continue;
    }
    if (j >= body.length) {
      i = j;
      continue;
    }
    const hex = String.fromCharCode(body[i + 1] ?? 0, body[i + 2] ?? 0);
    if (HEX.test(hex)) {
      out[length++] = parseInt(hex, 16);
      i += 2;
    } else {
      out[length++] = byte;
    }
  }
  return out.slice(0, length);
}

/** A leaf's body with its Content-Transfer-Encoding undone, byte for byte. */
export function decodeLeafBody(raw: Uint8Array, leaf: ScannedLeaf): Uint8Array {
  const body = raw.subarray(leaf.bodyStart, leaf.end);
  if (leaf.encoding === "base64") return decodeBase64(body);
  if (leaf.encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return body.slice();
}

function leafEntity(raw: Uint8Array, leaf: ScannedLeaf): Uint8Array {
  const entity = raw.subarray(leaf.start, leaf.end);
  if (!leaf.digestDefault) return entity;
  const prefix = new TextEncoder().encode("Content-Type: message/rfc822\r\n");
  const out = new Uint8Array(prefix.length + entity.length);
  out.set(prefix);
  out.set(entity, prefix.length);
  return out;
}

/** A body text part's value, charset-decoded by postal-mime. */
async function leafText(
  raw: Uint8Array,
  leaf: ScannedLeaf,
  kind: "text" | "html",
): Promise<string> {
  const parsed = await PostalMime.parse(leafEntity(raw, leaf));
  const value = (kind === "text" ? parsed.text : parsed.html) ?? "";
  // postal-mime's quoted-printable decoder ends the text with a line break
  // the part didn't have (the one before a boundary belongs to the boundary).
  const endsWithBreak = leaf.end > leaf.bodyStart && raw[leaf.end - 1] === 0x0a;
  return endsWithBreak ? value : value.replace(/\r?\n$/, "");
}

/** A part's file name, with RFC 2047 / 2231 encodings undone by postal-mime. */
async function leafFilename(
  raw: Uint8Array,
  leaf: ScannedLeaf,
): Promise<string | null> {
  const parsed = await PostalMime.parse(leafEntity(raw, leaf), {
    forceRfc822Attachments: true,
  });
  return parsed.attachments[0]?.filename ?? null;
}

function flattenAddresses(
  list: Address[] | undefined,
): { name?: string; email: string }[] {
  const out: { name?: string; email: string }[] = [];
  for (const entry of list ?? []) {
    const mailboxes = entry.group ?? [entry];
    for (const mailbox of mailboxes) {
      const email = (mailbox.address ?? "").trim();
      if (!email) continue;
      const name = (mailbox.name ?? "").trim();
      out.push(name ? { name, email } : { email });
    }
  }
  return out;
}

/** "<a@b> <c@d>" -> ["a@b", "c@d"]; a bare id is taken as is. */
export function parseMessageIdList(value: string | undefined): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^<>]*)>/g)].map((match) =>
    match[1].trim(),
  );
  if (bracketed.length > 0) return bracketed.filter(Boolean);
  return value.split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// The method
// ---------------------------------------------------------------------------

type ImportObject = {
  blobId: string;
  mailboxIds: string[];
  keywords: Record<string, true>;
  receivedAt: string | null;
};

/** Type checks only (spec §1): wrong types, unknown properties, nulls. */
export function validateImportObject(value: unknown): ImportObject | SetError {
  if (!isObject(value)) return { type: "invalidProperties" };
  const bad: string[] = [];
  for (const key of Object.keys(value)) {
    if (!IMPORT_PROPERTIES.has(key)) bad.push(key);
  }
  if (typeof value.blobId !== "string" || value.blobId.length === 0) {
    bad.push("blobId");
  }
  const mailboxIds = value.mailboxIds;
  if (
    !isObject(mailboxIds) ||
    Object.values(mailboxIds).some((item) => item !== true)
  ) {
    bad.push("mailboxIds");
  }
  const keywords = value.keywords === undefined ? {} : value.keywords;
  if (
    !isObject(keywords) ||
    Object.values(keywords).some((item) => item !== true)
  ) {
    bad.push("keywords");
  }
  let receivedAt: string | null = null;
  if (value.receivedAt !== undefined) {
    if (parseJmapDate(value.receivedAt, { utc: true }) === null) {
      bad.push("receivedAt");
    } else {
      receivedAt = value.receivedAt as string;
    }
  }
  if (bad.length > 0) return { type: "invalidProperties", properties: bad };
  return {
    blobId: value.blobId as string,
    mailboxIds: Object.keys(mailboxIds as Record<string, unknown>),
    keywords: keywords as Record<string, true>,
    receivedAt,
  };
}

/**
 * Drafts only (spec §1): `$draft` is required, and the target must name a
 * Drafts mailbox and no other system mailbox. Unknown ids are left for the
 * create path to reject.
 */
function draftsOnly(
  item: ImportObject,
  descriptorsById: Map<string, MailboxDescriptor>,
): SetError | null {
  if (!Object.prototype.hasOwnProperty.call(item.keywords, "$draft")) {
    return ONLY_DRAFTS;
  }
  let drafts = 0;
  for (const id of item.mailboxIds) {
    const descriptor = descriptorsById.get(id);
    if (!descriptor || !isSystemDescriptor(descriptor)) continue;
    if (descriptor.role !== "drafts") return ONLY_DRAFTS;
    drafts += 1;
  }
  return drafts === 0 ? ONLY_DRAFTS : null;
}

/**
 * aerc keeps one mailbox per role, so with two inboxes it may import into the
 * other inbox's Drafts. A single foreign Drafts becomes the From inbox's own.
 */
export function remapImportDrafts(
  mailboxIds: string[],
  fromInbox: string | null,
  descriptorsById: Map<string, MailboxDescriptor>,
): string[] {
  if (fromInbox === null) return mailboxIds;
  const own = fromInbox.toLowerCase();
  const drafts = mailboxIds.filter((id) => {
    const descriptor = descriptorsById.get(id);
    return (
      descriptor !== undefined &&
      isSystemDescriptor(descriptor) &&
      descriptor.role === "drafts"
    );
  });
  if (drafts.length !== 1) return mailboxIds;
  const current = descriptorsById.get(drafts[0])!;
  if (current.inbox.toLowerCase() === own) return mailboxIds;
  const target = [...descriptorsById.values()].find(
    (descriptor) =>
      isSystemDescriptor(descriptor) &&
      descriptor.role === "drafts" &&
      descriptor.inbox.toLowerCase() === own,
  );
  if (!target) return mailboxIds;
  return mailboxIds.map((id) => (id === drafts[0] ? target.id : id));
}

/** Properties of the import object itself; any other rejection is about the message. */
const ARGUMENT_PROPERTIES = new Set([
  "from",
  "mailboxIds",
  "keywords",
  "receivedAt",
]);

function importRejection(error: SetError): SetError {
  if (error.type !== "invalidProperties") return error;
  const properties = error.properties ?? [];
  if (
    properties.length > 0 &&
    properties.every((property) => ARGUMENT_PROPERTIES.has(property))
  ) {
    return error;
  }
  return {
    type: "invalidEmail",
    description:
      properties.length > 0
        ? `The message's ${properties.join(", ")} can't be stored as a draft`
        : "The message can't be stored as a draft",
  };
}

type ImportContext = {
  db: Db;
  env: CloudflareBindings;
  allowed: AllowedInboxes;
  userId: string;
  /** Upload limit = maxSizeAttachmentsPerEmail (the Session's one limit). */
  maxBytes: number;
  now: number;
  descriptorsById: Map<string, MailboxDescriptor>;
  /** The caller's usable identities; each one's inbox is its own address. */
  identityInboxes: Set<string>;
};

async function importOne(
  ctx: ImportContext,
  item: ImportObject,
): Promise<
  { id: string; blobId: string; threadId: string; size: number } | SetError
> {
  // Step 1: a blob the caller can read, within the upload limit.
  const blob = await resolveReadableBlob(
    ctx.db,
    ctx.allowed,
    ctx.userId,
    item.blobId,
  );
  if (!blob) return { type: "invalidProperties", properties: ["blobId"] };
  if (blob.size > ctx.maxBytes) {
    return {
      type: "tooLarge",
      description: `The message exceeds maxSizeUpload (${ctx.maxBytes} octets)`,
    };
  }
  const raw = await readBlobBytes(ctx.env, blob);
  if (!raw) return { type: "invalidProperties", properties: ["blobId"] };
  // The recorded size can be missing (a received message stored without
  // raw_size resolves as 0): the bytes read are what count.
  if (raw.byteLength > ctx.maxBytes) {
    return {
      type: "tooLarge",
      description: `The message exceeds maxSizeUpload (${ctx.maxBytes} octets)`,
    };
  }

  // Step 2: the raw tree, before any conversion.
  const scan = scanMimeStructure(raw);
  if (scan.error) return { type: "invalidEmail", description: scan.error };

  // Step 3: send limits, before anything is stored.
  if (scan.attachmentLeaves.length > MAX_SEND_ATTACHMENTS) {
    return {
      type: "tooLarge",
      description: `The message has ${scan.attachmentLeaves.length} attachments; at most ${MAX_SEND_ATTACHMENTS} can be sent`,
    };
  }
  const internalBlobs = new Map<string, InternalBlob>();
  const attachments: Record<string, unknown>[] = [];
  let attachmentBytes = 0;
  for (const [index, leaf] of scan.attachmentLeaves.entries()) {
    const bytes = decodeLeafBody(raw, leaf);
    attachmentBytes += bytes.byteLength;
    if (attachmentBytes > ctx.maxBytes) {
      return {
        type: "tooLarge",
        description: `Attachments exceed maxSizeAttachmentsPerEmail (${ctx.maxBytes} octets)`,
      };
    }
    const name = await leafFilename(raw, leaf);
    const blobId = `import-part-${index}`;
    internalBlobs.set(blobId, { bytes, type: leaf.type, name });
    const disposition =
      leaf.disposition === "inline" ||
      (leaf.disposition === null && leaf.inRelated && leaf.cid !== null)
        ? "inline"
        : "attachment";
    attachments.push({
      blobId,
      type: leaf.type,
      ...(name !== null ? { name } : {}),
      disposition,
      ...(leaf.cid !== null ? { cid: leaf.cid } : {}),
    });
  }

  // Step 4: an Email/set create object, through the ordinary draft path.
  const headerBytes = new Uint8Array(scan.headerEnd + 2);
  headerBytes.set(raw.subarray(0, scan.headerEnd));
  headerBytes.set([0x0d, 0x0a], scan.headerEnd);
  const headers = await PostalMime.parse(headerBytes);
  const from = flattenAddresses(headers.from ? [headers.from] : []);
  const fromEmail = from.length === 1 ? from[0].email.toLowerCase() : null;
  const fromInbox =
    fromEmail !== null && ctx.identityInboxes.has(fromEmail) ? fromEmail : null;
  const bodyValues: Record<string, { value: string }> = {};
  if (scan.textLeaf) {
    bodyValues.text = { value: await leafText(raw, scan.textLeaf, "text") };
  }
  if (scan.htmlLeaf) {
    bodyValues.html = { value: await leafText(raw, scan.htmlLeaf, "html") };
  }
  const to = flattenAddresses(headers.to);
  const cc = flattenAddresses(headers.cc);
  const bcc = flattenAddresses(headers.bcc);
  const replyTo = flattenAddresses(headers.replyTo);
  const messageId = parseMessageIdList(headers.messageId);
  const inReplyTo = parseMessageIdList(headers.inReplyTo);
  const references = parseMessageIdList(headers.references).slice(
    -MAX_IMPORT_REFERENCES,
  );
  // postal-mime gives a valid Date header as an ISO string, in UTC.
  const sentAt =
    headers.date && parseJmapDate(headers.date) !== null
      ? headers.date.replace(/\.000Z$/, "Z")
      : null;
  const create: Record<string, unknown> = {
    mailboxIds: Object.fromEntries(
      remapImportDrafts(item.mailboxIds, fromInbox, ctx.descriptorsById).map(
        (id) => [id, true],
      ),
    ),
    keywords: item.keywords,
    from,
    ...(to.length > 0 ? { to } : {}),
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(replyTo.length > 0 ? { replyTo } : {}),
    ...(headers.subject !== undefined ? { subject: headers.subject } : {}),
    ...(sentAt !== null ? { sentAt } : {}),
    ...(item.receivedAt !== null ? { receivedAt: item.receivedAt } : {}),
    ...(messageId.length > 0 ? { messageId: messageId.slice(0, 1) } : {}),
    ...(inReplyTo.length > 0 ? { inReplyTo } : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(scan.textLeaf
      ? { textBody: [{ partId: "text", type: "text/plain" }] }
      : {}),
    ...(scan.htmlLeaf
      ? { htmlBody: [{ partId: "html", type: "text/html" }] }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    bodyValues,
  };

  const result = await createDraftEmail(
    {
      db: ctx.db,
      env: ctx.env,
      allowed: ctx.allowed,
      userId: ctx.userId,
      maxAttachmentBytes: ctx.maxBytes,
      now: ctx.now,
    },
    create,
    { internalBlobs },
  );
  if (result instanceof Rejection) return importRejection(result.error);
  return result;
}

/**
 * RFC 8621 §4.8 Email/import, drafts only (spec 2026-09-28): each message is
 * parsed into saasmail's own draft structure and created through the
 * Email/set create path, so every draft rule applies. The created Email's
 * blobId is the rebuilt message, not the uploaded blob.
 */
export async function emailImport(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
  ctx: JmapMethodContext,
): Promise<Record<string, unknown> | JmapMethodError> {
  const emails = args.emails;
  if (!isObject(emails) || Object.keys(emails).length === 0) {
    return { type: "invalidArguments", properties: ["emails"] };
  }
  if (Object.keys(emails).length > MAX_OBJECTS_IN_SET) {
    return {
      type: "requestTooLarge",
      description: `emails exceeds maxObjectsInSet (${MAX_OBJECTS_IN_SET})`,
    };
  }

  const currentState = await currentJmapState(db, allowed, userId);
  const oldState = currentState.state;
  if (args.ifInState !== undefined && args.ifInState !== null) {
    const ifInState = parseJmapState(args.ifInState);
    if (
      !ifInState ||
      ifInState.seq !== currentState.parts.seq ||
      ifInState.fp !== currentState.parts.fp
    ) {
      return { type: "stateMismatch" };
    }
  }

  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};
  // Every object's arguments are checked before any blob is read.
  const valid: [string, ImportObject][] = [];
  for (const [creationId, value] of Object.entries(emails)) {
    const item = validateImportObject(value);
    if ("type" in item) notCreated[creationId] = item as SetError;
    else valid.push([creationId, item as ImportObject]);
  }

  if (valid.length > 0) {
    const descriptors = await loadMailboxDescriptors(db, allowed);
    const descriptorsById = new Map(
      descriptors.map((descriptor) => [descriptor.id, descriptor]),
    );
    const identityInboxes = new Set(
      (await listUsableIdentities(db, allowed)).map((row) =>
        row.email.toLowerCase(),
      ),
    );
    const sender = ctx.sender ?? createEmailSender(ctx.env);
    const importCtx: ImportContext = {
      db,
      env: ctx.env,
      allowed,
      userId,
      maxBytes: sender.maxAttachmentBytes(),
      now: Math.floor(Date.now() / 1000),
      descriptorsById,
      identityInboxes,
    };
    // Creation ids become usable later in the request when executeJmapCalls
    // records this response's `created` (RFC 8620 §5.3).
    for (const [creationId, item] of valid) {
      const refused = draftsOnly(item, descriptorsById);
      if (refused) {
        notCreated[creationId] = refused;
        continue;
      }
      try {
        const result = await importOne(importCtx, item);
        if ("type" in result) {
          notCreated[creationId] = result as SetError;
          continue;
        }
        created[creationId] = result;
      } catch (error) {
        console.error(`[jmap] Email/import ${creationId} failed:`, error);
        notCreated[creationId] = {
          type: "serverFail",
          description: "The message could not be imported",
        };
      }
    }
  }

  const newState = (await currentJmapState(db, allowed, userId)).state;
  return {
    accountId,
    oldState,
    newState,
    created: Object.keys(created).length > 0 ? created : null,
    notCreated: Object.keys(notCreated).length > 0 ? notCreated : null,
  };
}
