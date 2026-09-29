import { eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { people } from "../db/people.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { computeConversationId, externalsOnly } from "../lib/conversation-id";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { parseJmapDate } from "./dates";
import { readBlobBytes, resolveReadableBlob, type ResolvedBlob } from "./blobs";
import {
  contentLeaves,
  contentPreview,
  deleteContentIfUnreferenced,
  deriveBodyLists,
  toCrlf,
  utf8Bytes,
  type ContentAddress,
  type ContentMultipart,
  type ContentPart,
} from "./content";
import { jmapThreadKey, loadJmapEmailObjectsByIds } from "./emails";
import { validateDraftTarget } from "./draft-target";
import { listUsableIdentities, loadMailboxDescriptors } from "./mailboxes";
import {
  publicDraftEmailId,
  publicEmailId,
  publicRawBlobId,
  publicThreadId,
} from "./public-ids";
import { buildRawMessage } from "./raw-message";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export type SetError = {
  type: string;
  description?: string;
  properties?: string[];
  notFound?: string[];
};

/** A per-object /set failure. A class so `instanceof` narrows with strict off. */
export class Rejection {
  constructor(readonly error: SetError) {}
}

function reject(...properties: string[]): Rejection {
  return new Rejection({ type: "invalidProperties", properties });
}

/** Mirrors the web composer's cap (routers/send-router.ts). */
export const MAX_CC_ENTRIES = 50;
const MAX_TO_ENTRIES = 50;
const MAX_BCC_ENTRIES = 50;
const MAX_REPLY_TO_ENTRIES = 10;
const MAX_ATTACHMENTS = 100;
const MAX_BODY_LEAVES = 100;
const MAX_STRUCTURE_DEPTH = 4;
const MAX_SUBJECT_LENGTH = 900;
const MAX_NAME_LENGTH = 256;
const MAX_MESSAGE_ID_LENGTH = 250;
const MAX_REFERENCES = 100;

export const DRAFT_KEYWORDS: ReadonlySet<string> = new Set([
  "$draft",
  "$seen",
  "$flagged",
]);

type Disposition = "attachment" | "inline" | null;

export type BodyInputText = {
  kind: "text";
  type: "text/plain" | "text/html";
  /** LF line endings (RFC 8621 EmailBodyValue). */
  value: string;
  name: string | null;
  disposition: Disposition;
  cid: string | null;
};

export type BodyInputBlob = {
  kind: "blob";
  blobId: string;
  /** null = take the resolved blob's type. */
  type: string | null;
  name: string | null;
  disposition: Disposition;
  cid: string | null;
};

export type BodyInputMultipart = {
  kind: "multipart";
  type: ContentMultipart["type"];
  subParts: BodyInput[];
};

export type BodyInput = BodyInputText | BodyInputBlob | BodyInputMultipart;

export function isInputMultipart(part: BodyInput): part is BodyInputMultipart {
  return part.kind === "multipart";
}
export function isTextInput(part: BodyInput): part is BodyInputText {
  return part.kind === "text";
}
export function isBlobInput(part: BodyInput): part is BodyInputBlob {
  return part.kind === "blob";
}

export function inputLeaves(
  part: BodyInput,
): (BodyInputText | BodyInputBlob)[] {
  if (isInputMultipart(part)) return part.subParts.flatMap(inputLeaves);
  return [part as BodyInputText | BodyInputBlob];
}

export type ParsedEmailCreate = {
  /** The one mailbox id given (checked against the identity's Drafts later). */
  mailboxIds: string[];
  seen: boolean;
  flagged: boolean;
  from: ContentAddress;
  to: ContentAddress[];
  cc: ContentAddress[];
  bcc: ContentAddress[];
  replyTo: ContentAddress[] | null;
  subject: string;
  /** null = server generates. */
  messageId: string | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  /** RFC 3339 as given; null = server sets now. */
  sentAt: string | null;
  /** Unix seconds; null = server sets now. */
  receivedAt: number | null;
  body: BodyInput;
};

const CREATE_PROPERTIES = new Set([
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "sender",
  "subject",
  "sentAt",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "bodyStructure",
  "textBody",
  "htmlBody",
  "attachments",
  "bodyValues",
]);
const SERVER_SET = new Set([
  "id",
  "blobId",
  "threadId",
  "size",
  "hasAttachment",
  "preview",
]);
const PART_KEYS = new Set([
  "partId",
  "blobId",
  "type",
  "charset",
  "name",
  "disposition",
  "cid",
  "size",
  "subParts",
  "language",
  "location",
]);

const HEADER_UNSAFE = /[\r\n]/;
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;
const MESSAGE_ID_PATTERN = /^[^\s<>]+@[^\s<>]+$/;
const CID_PATTERN = /^[^\s<>]+$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

function parseAddress(value: unknown): ContentAddress | null {
  if (!isObject(value)) return null;
  for (const key of Object.keys(value)) {
    if (key !== "name" && key !== "email") return null;
  }
  const email = value.email;
  const name = value.name;
  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return null;
  }
  if (
    !absent(name) &&
    (typeof name !== "string" ||
      HEADER_UNSAFE.test(name) ||
      name.length > MAX_NAME_LENGTH)
  ) {
    return null;
  }
  const trimmed = typeof name === "string" ? name.trim() : "";
  return { name: trimmed.length > 0 ? trimmed : null, email: email.trim() };
}

/** [] when absent; null when invalid. */
function parseAddressList(
  value: unknown,
  max: number,
): ContentAddress[] | null {
  if (absent(value)) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const result: ContentAddress[] = [];
  for (const item of value) {
    const address = parseAddress(item);
    if (!address) return null;
    result.push(address);
  }
  return result;
}

/** { ids: null } when absent; null when invalid. */
function parseMessageIds(
  value: unknown,
  max: number,
): { ids: string[] | null } | null {
  if (absent(value)) return { ids: null };
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    return null;
  }
  const ids: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length > MAX_MESSAGE_ID_LENGTH ||
      !MESSAGE_ID_PATTERN.test(item)
    ) {
      return null;
    }
    ids.push(item);
  }
  return { ids };
}

function parseBodyValues(value: unknown): Map<string, string> | null {
  const values = new Map<string, string>();
  if (absent(value)) return values;
  if (!isObject(value)) return null;
  for (const [partId, entry] of Object.entries(value)) {
    if (!isObject(entry) || typeof entry.value !== "string") return null;
    for (const key of Object.keys(entry)) {
      if (
        key !== "value" &&
        key !== "isEncodingProblem" &&
        key !== "isTruncated"
      ) {
        return null;
      }
    }
    if (!absent(entry.isEncodingProblem) && entry.isEncodingProblem !== false) {
      return null;
    }
    if (!absent(entry.isTruncated) && entry.isTruncated !== false) return null;
    values.set(partId, entry.value.replace(/\r\n/g, "\n"));
  }
  return values;
}

type LeafCommon = {
  name: string | null;
  disposition: Disposition;
  cid: string | null;
};

function parseLeafCommon(
  value: Record<string, unknown>,
  property: string,
): LeafCommon | Rejection {
  let name: string | null = null;
  if (!absent(value.name)) {
    if (
      typeof value.name !== "string" ||
      HEADER_UNSAFE.test(value.name) ||
      value.name.length > MAX_NAME_LENGTH
    ) {
      return reject(property);
    }
    name = value.name.trim() || null;
  }
  let disposition: Disposition = null;
  if (!absent(value.disposition)) {
    const given =
      typeof value.disposition === "string"
        ? value.disposition.toLowerCase()
        : "";
    if (given !== "inline" && given !== "attachment") return reject(property);
    disposition = given;
  }
  let cid: string | null = null;
  if (!absent(value.cid)) {
    if (typeof value.cid !== "string") return reject(property);
    const bare = value.cid.replace(/^<(.*)>$/, "$1");
    if (!CID_PATTERN.test(bare) || bare.length > MAX_MESSAGE_ID_LENGTH) {
      return reject(property);
    }
    cid = bare;
  }
  if (!absent(value.language) || !absent(value.location)) {
    return reject(property);
  }
  return { name, disposition, cid };
}

function mediaType(value: unknown): string | null | Rejection {
  if (absent(value)) return null;
  if (typeof value !== "string") return reject();
  const type = value.trim().toLowerCase();
  return MEDIA_TYPE.test(type) ? type : reject();
}

/** A text part (partId) or blob part (blobId); never both. */
function parseLeaf(
  value: Record<string, unknown>,
  bodyValues: Map<string, string>,
  property: string,
  onlyText: "text/plain" | "text/html" | null,
): BodyInputText | BodyInputBlob | Rejection {
  const type = mediaType(value.type);
  if (type instanceof Rejection) return reject(property);
  const common = parseLeafCommon(value, property);
  if (common instanceof Rejection) return common;
  const hasPartId = !absent(value.partId);
  const hasBlobId = !absent(value.blobId);
  if (hasPartId === hasBlobId) return reject(property);

  if (hasPartId) {
    const textType = type ?? onlyText ?? "text/plain";
    if (textType !== "text/plain" && textType !== "text/html") {
      return reject(property);
    }
    if (onlyText !== null && textType !== onlyText) return reject(property);
    if (
      !absent(value.charset) &&
      (typeof value.charset !== "string" ||
        value.charset.toLowerCase() !== "utf-8")
    ) {
      return reject(property);
    }
    if (!absent(value.size)) return reject(property);
    if (typeof value.partId !== "string") return reject(property);
    const text = bodyValues.get(value.partId);
    if (text === undefined) return reject(property);
    return { kind: "text", type: textType, value: text, ...common };
  }

  if (onlyText !== null) return reject(property);
  if (typeof value.blobId !== "string") return reject(property);
  return { kind: "blob", blobId: value.blobId, type, ...common };
}

function parseStructurePart(
  value: unknown,
  bodyValues: Map<string, string>,
  depth: number,
): BodyInput | Rejection {
  if (depth > MAX_STRUCTURE_DEPTH || !isObject(value)) {
    return reject("bodyStructure");
  }
  for (const key of Object.keys(value)) {
    if (!PART_KEYS.has(key)) return reject("bodyStructure");
  }
  const type =
    typeof value.type === "string" ? value.type.trim().toLowerCase() : null;
  if (type !== null && type.startsWith("multipart/")) {
    if (
      type !== "multipart/mixed" &&
      type !== "multipart/alternative" &&
      type !== "multipart/related"
    ) {
      return reject("bodyStructure");
    }
    if (!absent(value.partId) || !absent(value.blobId)) {
      return reject("bodyStructure");
    }
    if (!Array.isArray(value.subParts) || value.subParts.length === 0) {
      return reject("bodyStructure");
    }
    const subParts: BodyInput[] = [];
    for (const sub of value.subParts) {
      const parsed = parseStructurePart(sub, bodyValues, depth + 1);
      if (parsed instanceof Rejection) return parsed;
      subParts.push(parsed);
    }
    return { kind: "multipart", type, subParts };
  }
  if (!absent(value.subParts)) return reject("bodyStructure");
  return parseLeaf(value, bodyValues, "bodyStructure", null);
}

function isTextLeaf(part: BodyInput, type: string): boolean {
  return (
    isTextInput(part) && part.type === type && part.disposition !== "attachment"
  );
}

function isRelated(part: BodyInput): boolean {
  return (
    isInputMultipart(part) &&
    part.type === "multipart/related" &&
    part.subParts.length >= 2 &&
    isTextLeaf(part.subParts[0], "text/html") &&
    part.subParts.slice(1).every(isBlobInput)
  );
}

/**
 * Spec §3.1 shapes: text | html | alternative(text, html|related)
 * | related(html, inline blobs…), optionally inside mixed(body, attachments…).
 */
function isBody(part: BodyInput): boolean {
  if (isTextLeaf(part, "text/plain") || isTextLeaf(part, "text/html"))
    return true;
  if (isRelated(part)) return true;
  if (!isInputMultipart(part) || part.type !== "multipart/alternative") {
    return false;
  }
  if (part.subParts.length !== 2) return false;
  const plain = part.subParts.filter((sub) => isTextLeaf(sub, "text/plain"));
  const rich = part.subParts.filter(
    (sub) => isTextLeaf(sub, "text/html") || isRelated(sub),
  );
  return plain.length === 1 && rich.length === 1;
}

function isSupportedShape(root: BodyInput): boolean {
  if (isBody(root)) return true;
  return (
    isInputMultipart(root) &&
    root.type === "multipart/mixed" &&
    root.subParts.length >= 2 &&
    isBody(root.subParts[0]) &&
    root.subParts.slice(1).every(isBlobInput)
  );
}

function parseFlatBody(
  value: unknown,
  type: "text/plain" | "text/html",
  property: string,
  bodyValues: Map<string, string>,
): BodyInputText | null | Rejection {
  if (absent(value)) return null;
  if (!Array.isArray(value)) return reject(property);
  if (value.length === 0) return null;
  if (value.length !== 1 || !isObject(value[0])) return reject(property);
  for (const key of Object.keys(value[0])) {
    if (!PART_KEYS.has(key) || key === "subParts") return reject(property);
  }
  const parsed = parseLeaf(value[0], bodyValues, property, type);
  if (parsed instanceof Rejection) return parsed;
  return parsed as BodyInputText;
}

function parseFlatAttachments(value: unknown): BodyInputBlob[] | Rejection {
  if (absent(value)) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    return reject("attachments");
  }
  const result: BodyInputBlob[] = [];
  for (const item of value) {
    if (!isObject(item)) return reject("attachments");
    for (const key of Object.keys(item)) {
      if (!PART_KEYS.has(key) || key === "subParts")
        return reject("attachments");
    }
    if (!absent(item.partId)) return reject("attachments");
    const parsed = parseLeaf(item, new Map(), "attachments", null);
    if (parsed instanceof Rejection) return parsed;
    result.push(parsed as BodyInputBlob);
  }
  return result;
}

/** RFC 8621 §4.6: the server builds the structure from the flattened form. */
function flatToStructure(
  input: Record<string, unknown>,
  bodyValues: Map<string, string>,
): BodyInput | Rejection {
  const text = parseFlatBody(
    input.textBody,
    "text/plain",
    "textBody",
    bodyValues,
  );
  if (text instanceof Rejection) return text;
  const html = parseFlatBody(
    input.htmlBody,
    "text/html",
    "htmlBody",
    bodyValues,
  );
  if (html instanceof Rejection) return html;
  const attachments = parseFlatAttachments(input.attachments);
  if (attachments instanceof Rejection) return attachments;

  const inline = html
    ? attachments.filter(
        (part) => part.disposition === "inline" && part.cid !== null,
      )
    : [];
  const regular = attachments
    .filter((part) => !inline.includes(part))
    .map((part) => ({
      ...part,
      disposition: part.disposition ?? ("attachment" as const),
    }));

  let rich: BodyInput | null = html;
  if (html && inline.length > 0) {
    rich = {
      kind: "multipart",
      type: "multipart/related",
      subParts: [html, ...inline],
    };
  }
  let body: BodyInput;
  if (text && rich) {
    body = {
      kind: "multipart",
      type: "multipart/alternative",
      subParts: [text, rich],
    };
  } else {
    body = text ??
      rich ?? {
        kind: "text",
        type: "text/plain",
        value: "",
        name: null,
        disposition: null,
        cid: null,
      };
  }
  return regular.length > 0
    ? {
        kind: "multipart",
        type: "multipart/mixed",
        subParts: [body, ...regular],
      }
    : body;
}

export function parseEmailCreate(
  input: unknown,
): ParsedEmailCreate | Rejection {
  if (!isObject(input)) return reject();
  for (const key of Object.keys(input)) {
    if (key === "headers" || key.startsWith("header:")) return reject(key);
    if (SERVER_SET.has(key) || !CREATE_PROPERTIES.has(key)) return reject(key);
  }

  const mailboxIds = input.mailboxIds;
  if (
    !isObject(mailboxIds) ||
    Object.keys(mailboxIds).length === 0 ||
    Object.values(mailboxIds).some((value) => value !== true)
  ) {
    return reject("mailboxIds");
  }

  const keywords = input.keywords;
  if (
    !isObject(keywords) ||
    Object.values(keywords).some((value) => value !== true)
  ) {
    return reject("keywords");
  }
  const keywordSet = new Set(Object.keys(keywords));
  if (
    !keywordSet.has("$draft") ||
    [...keywordSet].some((keyword) => !DRAFT_KEYWORDS.has(keyword))
  ) {
    return reject("keywords");
  }

  if (!absent(input.sender)) return reject("sender");
  const from = parseAddressList(input.from, 1);
  if (!from || from.length !== 1) return reject("from");
  const to = parseAddressList(input.to, MAX_TO_ENTRIES);
  if (!to) return reject("to");
  const cc = parseAddressList(input.cc, MAX_CC_ENTRIES);
  if (!cc) return reject("cc");
  const bcc = parseAddressList(input.bcc, MAX_BCC_ENTRIES);
  if (!bcc) return reject("bcc");
  let replyTo: ContentAddress[] | null = null;
  if (!absent(input.replyTo)) {
    replyTo = parseAddressList(input.replyTo, MAX_REPLY_TO_ENTRIES);
    if (!replyTo || replyTo.length === 0) return reject("replyTo");
  }

  let subject = "";
  if (!absent(input.subject)) {
    if (
      typeof input.subject !== "string" ||
      HEADER_UNSAFE.test(input.subject) ||
      input.subject.length > MAX_SUBJECT_LENGTH
    ) {
      return reject("subject");
    }
    subject = input.subject;
  }

  let sentAt: string | null = null;
  if (!absent(input.sentAt)) {
    if (
      typeof input.sentAt !== "string" ||
      parseJmapDate(input.sentAt) === null
    ) {
      return reject("sentAt");
    }
    sentAt = input.sentAt;
  }

  let receivedAt: number | null = null;
  if (!absent(input.receivedAt)) {
    const ms = parseJmapDate(input.receivedAt, { utc: true });
    if (ms === null) return reject("receivedAt");
    receivedAt = Math.floor(ms / 1000);
  }

  const messageId = parseMessageIds(input.messageId, 1);
  if (!messageId) return reject("messageId");
  const inReplyTo = parseMessageIds(input.inReplyTo, MAX_REFERENCES);
  if (!inReplyTo) return reject("inReplyTo");
  const references = parseMessageIds(input.references, MAX_REFERENCES);
  if (!references) return reject("references");

  const bodyValues = parseBodyValues(input.bodyValues);
  if (!bodyValues) return reject("bodyValues");
  const hasStructure = !absent(input.bodyStructure);
  const hasFlat = ["textBody", "htmlBody", "attachments"].some(
    (key) => !absent(input[key]),
  );
  if (hasStructure && hasFlat) return reject("bodyStructure");

  let body: BodyInput;
  if (hasStructure) {
    const parsed = parseStructurePart(input.bodyStructure, bodyValues, 0);
    if (parsed instanceof Rejection) return parsed;
    if (!isSupportedShape(parsed)) return reject("bodyStructure");
    body = parsed;
  } else {
    const parsed = flatToStructure(input, bodyValues);
    if (parsed instanceof Rejection) return parsed;
    body = parsed;
  }
  if (inputLeaves(body).length > MAX_BODY_LEAVES) {
    return reject(hasStructure ? "bodyStructure" : "attachments");
  }

  return {
    mailboxIds: Object.keys(mailboxIds),
    seen: keywordSet.has("$seen"),
    flagged: keywordSet.has("$flagged"),
    from: from[0],
    to,
    cc,
    bcc,
    replyTo,
    subject,
    messageId: messageId.ids ? messageId.ids[0] : null,
    inReplyTo: inReplyTo.ids,
    references: references.ids,
    sentAt,
    receivedAt,
    body,
  };
}

/** Domains of our sender identities (same rule as send-email.ts fetchInternalDomains). */
async function internalDomains(db: Db): Promise<string[]> {
  const rows = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities);
  return [
    ...new Set(
      rows
        .map((row) =>
          row.email.slice(row.email.lastIndexOf("@") + 1).toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
}

async function threadKeyForMessageId(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  messageId: string,
): Promise<string | null> {
  const forms = [messageId, `<${messageId}>`];
  // The inbox list is bound once, as JSON, and shared by the three arms: D1
  // takes at most 100 bound parameters per statement.
  const inboxes = allowed.isAdmin
    ? null
    : JSON.stringify((allowed as { inboxes: string[] }).inboxes);
  const scope = (column: SQL) =>
    inboxes === null
      ? sql``
      : sql`AND ${column} IN (SELECT value FROM scope_inboxes)`;
  const rows = await db.all<{ kind: "received" | "sent"; id: string }>(sql`
    WITH scope_inboxes(value) AS (SELECT value FROM json_each(${inboxes ?? "[]"}))
    SELECT 'received' AS kind, e.id AS id FROM emails e
     WHERE e.message_id IN ${forms} ${scope(sql`e.recipient`)}
    UNION ALL
    SELECT 'sent' AS kind, se.id AS id FROM sent_emails se
     WHERE se.message_id IN ${forms} ${scope(sql`se.from_address`)}
    UNION ALL
    -- A JMAP send is recorded under the id it was delivered with, which a
    -- provider like Cloudflare assigns; a JMAP client cites the Email's own.
    SELECT 'sent' AS kind, se.id AS id FROM sent_emails se
      JOIN jmap_message_content jmc ON jmc.id = se.jmap_content_id
     WHERE jmc.message_id IN ${forms} ${scope(sql`se.from_address`)}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  // Loaded by ref, then read positionally: a Sent row that was aliased onto a
  // draft comes back keyed by the draft's `D…` id, not the `S…` id we asked
  // with, and its thread key is what this needs.
  const loaded = await loadJmapEmailObjectsByIds(db, allowed, userId, [
    publicEmailId({ kind: row.kind, id: row.id }),
  ]);
  const message = [...loaded.values()][0];
  return message ? jmapThreadKey(message) : null;
}

/**
 * Master plan Decision 9. A reply joins the visible message it answers; any
 * other draft gets the key its Sent row will naturally get, so sending it
 * doesn't split the thread; failing that, a thread of its own.
 */
export async function draftThreadKey(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  input: {
    inbox: string;
    draftId: string;
    to: ContentAddress[];
    cc: ContentAddress[];
    inReplyTo: string[] | null;
    references: string[] | null;
  },
): Promise<string> {
  const candidates = [
    ...(input.inReplyTo ?? []),
    ...[...(input.references ?? [])].reverse(),
  ].slice(0, 20);
  for (const messageId of candidates) {
    const key = await threadKeyForMessageId(db, allowed, userId, messageId);
    if (key) return key;
  }

  const externals = externalsOnly(
    [...input.to, ...input.cc].map((address) => address.email.toLowerCase()),
    await internalDomains(db),
  );
  const conversationId = await computeConversationId(input.inbox, externals);
  if (conversationId) return conversationId;

  if (input.to.length === 1) {
    const [person] = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.email, input.to[0].email.toLowerCase()))
      .limit(1);
    if (person) return `p:${person.id}`;
  }
  return `draft:${input.draftId}`;
}

export type DraftCreateContext = {
  db: Db;
  env: CloudflareBindings;
  allowed: AllowedInboxes;
  userId: string;
  /** maxSizeAttachmentsPerEmail. */
  maxAttachmentBytes: number;
  /** Unix seconds. */
  now: number;
};

export type CreatedDraft = {
  id: string;
  blobId: string;
  threadId: string;
  size: number;
};

/**
 * A part held in memory rather than in a blob store: `Email/import` passes the
 * parts it decoded from the imported message under synthetic blob ids, so a
 * rejected import stores nothing. Only server code builds this map; a client's
 * blob id is never looked up in it.
 */
export type InternalBlob = {
  bytes: Uint8Array;
  type: string;
  name: string | null;
};

export type DraftCreateOptions = {
  internalBlobs?: Map<string, InternalBlob>;
};

function rfc3339Utc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Email/set create for one draft (spec §3.1). Returns a Rejection for a
 * per-object SetError. Throws, after removing everything it wrote, when an
 * R2 write fails; the caller reports that object as failed.
 */
export async function createDraftEmail(
  ctx: DraftCreateContext,
  input: unknown,
  options: DraftCreateOptions = {},
): Promise<CreatedDraft | Rejection> {
  const parsed = parseEmailCreate(input);
  if (parsed instanceof Rejection) return parsed;

  const identities = await listUsableIdentities(ctx.db, ctx.allowed);
  const fromEmail = parsed.from.email.toLowerCase();
  const identity = identities.find(
    (row) => row.email.toLowerCase() === fromEmail,
  );
  if (!identity) return reject("from");
  const inbox = identity.email.toLowerCase();
  // Drafts, plus any custom folders of the same inbox; never created in Trash.
  const descriptors = await loadMailboxDescriptors(ctx.db, ctx.allowed);
  const target = validateDraftTarget(
    inbox,
    new Set(parsed.mailboxIds),
    new Map(descriptors.map((descriptor) => [descriptor.id, descriptor])),
  );
  if ("type" in target || target.role !== "drafts") {
    return reject("mailboxIds");
  }

  // Resolve every blob now, reporting all missing ids at once (spec §3.1).
  const blobLeaves = inputLeaves(parsed.body).filter(isBlobInput);
  const blobs = new Map<string, ResolvedBlob>();
  const notFound: string[] = [];
  for (const leaf of blobLeaves) {
    if (blobs.has(leaf.blobId) || notFound.includes(leaf.blobId)) continue;
    const internal = options.internalBlobs?.get(leaf.blobId);
    if (internal) {
      blobs.set(leaf.blobId, {
        blobId: leaf.blobId,
        type: internal.type,
        size: internal.bytes.byteLength,
        name: internal.name,
        source: { bytes: internal.bytes },
      });
      continue;
    }
    const blob = await resolveReadableBlob(
      ctx.db,
      ctx.allowed,
      ctx.userId,
      leaf.blobId,
    );
    if (blob) blobs.set(leaf.blobId, blob);
    else notFound.push(leaf.blobId);
  }
  if (notFound.length > 0) {
    return new Rejection({ type: "blobNotFound", notFound });
  }
  // The size check uses each blob's recorded size, so an oversized create is
  // refused before any of its bytes are held in memory.
  let attachmentBytes = 0;
  for (const leaf of blobLeaves) {
    attachmentBytes += blobs.get(leaf.blobId)!.size;
  }
  if (attachmentBytes > ctx.maxAttachmentBytes) {
    return new Rejection({
      type: "tooLarge",
      description: `Attachments exceed maxSizeAttachmentsPerEmail (${ctx.maxAttachmentBytes} octets)`,
    });
  }
  const resolved = new Map<string, { blob: ResolvedBlob; bytes: Uint8Array }>();
  for (const [blobId, blob] of blobs) {
    const bytes = await readBlobBytes(ctx.env, blob);
    if (bytes) resolved.set(blobId, { blob, bytes });
    else notFound.push(blobId);
  }
  if (notFound.length > 0) {
    return new Rejection({ type: "blobNotFound", notFound });
  }

  const draftId = nanoid();
  const contentId = nanoid();
  const prefix = `jmap-content/${ctx.userId}/${contentId}`;
  const bodyValues: Record<string, string> = {};
  const leafBytes = new Map<string, Uint8Array>();
  let counter = 0;
  const freeze = (part: BodyInput): ContentPart => {
    if (isInputMultipart(part)) {
      const multipart: ContentMultipart = {
        partId: null,
        type: part.type,
        subParts: part.subParts.map(freeze),
      };
      return multipart;
    }
    counter += 1;
    const partId = String(counter);
    if (isTextInput(part)) {
      bodyValues[partId] = part.value;
      return {
        partId,
        type: part.type,
        charset: "utf-8",
        name: part.name,
        disposition: part.disposition,
        cid: part.cid,
        size: utf8Bytes(toCrlf(part.value)).byteLength,
        r2Key: null,
      };
    }
    const blobPart = part as BodyInputBlob;
    const { blob, bytes } = resolved.get(blobPart.blobId)!;
    leafBytes.set(partId, bytes);
    return {
      partId,
      type: (blobPart.type ?? blob.type).toLowerCase(),
      charset: null,
      name: blobPart.name ?? blob.name,
      disposition: blobPart.disposition,
      cid: blobPart.cid,
      size: bytes.byteLength,
      r2Key: `${prefix}/${partId}`,
    };
  };
  const root = freeze(parsed.body);
  const lists = deriveBodyLists(root);

  const threadKey = await draftThreadKey(ctx.db, ctx.allowed, ctx.userId, {
    inbox,
    draftId,
    to: parsed.to,
    cc: parsed.cc,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
  });
  const messageId =
    parsed.messageId ??
    `${nanoid()}@${inbox.slice(inbox.lastIndexOf("@") + 1)}`;
  const sentAt = parsed.sentAt ?? rfc3339Utc(ctx.now);
  const receivedAt = parsed.receivedAt ?? ctx.now;
  const raw = buildRawMessage(
    {
      contentId,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      replyTo: parsed.replyTo,
      subject: parsed.subject,
      messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      sentAt,
      root,
      bodyValues,
    },
    leafBytes,
  );
  const rawKey = `${prefix}.eml`;

  // Master plan Decision 6: content row, then R2 objects, then the draft row.
  await ctx.db.insert(jmapMessageContent).values({
    id: contentId,
    createdBy: ctx.userId,
    inbox,
    fromJson: JSON.stringify([parsed.from]),
    toJson: JSON.stringify(parsed.to),
    ccJson: JSON.stringify(parsed.cc),
    bccJson: JSON.stringify(parsed.bcc),
    replyToJson: parsed.replyTo ? JSON.stringify(parsed.replyTo) : null,
    subject: parsed.subject,
    messageId,
    inReplyToJson: parsed.inReplyTo ? JSON.stringify(parsed.inReplyTo) : null,
    referencesJson: parsed.references
      ? JSON.stringify(parsed.references)
      : null,
    sentAt,
    partsJson: JSON.stringify(root),
    textBodyJson: JSON.stringify(lists.textBody),
    htmlBodyJson: JSON.stringify(lists.htmlBody),
    attachmentsJson: JSON.stringify(lists.attachments),
    bodyValuesJson: JSON.stringify(bodyValues),
    preview: contentPreview(root, bodyValues, lists),
    threadKey,
    rawR2Key: rawKey,
    size: raw.byteLength,
    createdAt: ctx.now,
  });

  const objects: { key: string; bytes: Uint8Array; type: string }[] = [
    ...contentLeaves(root)
      .filter((leaf) => leaf.r2Key !== null)
      .map((leaf) => ({
        key: leaf.r2Key!,
        bytes: leafBytes.get(leaf.partId)!,
        type: leaf.type,
      })),
    { key: rawKey, bytes: raw, type: "message/rfc822" },
  ];
  const puts = await Promise.allSettled(
    objects.map((object) =>
      ctx.env.R2.put(object.key, object.bytes, {
        httpMetadata: { contentType: object.type },
      }),
    ),
  );
  const failed = puts.find(
    (put): put is PromiseRejectedResult => put.status === "rejected",
  );
  if (failed) {
    try {
      await ctx.env.R2.delete(objects.map((object) => object.key));
      await ctx.db
        .delete(jmapMessageContent)
        .where(eq(jmapMessageContent.id, contentId));
    } catch (cleanupError) {
      // Content GC removes whatever is left (R2 first, then the row).
      console.error(
        `[jmap] cleanup of content ${contentId} failed:`,
        cleanupError,
      );
    }
    throw failed.reason;
  }

  try {
    await ctx.db.insert(jmapDrafts).values({
      id: draftId,
      userId: ctx.userId,
      contentId,
      inbox,
      receivedAt,
      mailboxRole: "drafts",
      seen: parsed.seen ? 1 : 0,
      flagged: parsed.flagged ? 1 : 0,
      folderIds: JSON.stringify([...new Set(target.folders)].sort()),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
  } catch (insertError) {
    // Nothing references the content yet: remove it and its R2 objects now
    // rather than leaving them to the content GC (which still catches them
    // if this cleanup fails too).
    try {
      await deleteContentIfUnreferenced(ctx.db, ctx.env, contentId);
    } catch (cleanupError) {
      console.error(
        `[jmap] cleanup of content ${contentId} failed:`,
        cleanupError,
      );
    }
    throw insertError;
  }

  return {
    id: publicDraftEmailId(draftId),
    blobId: publicRawBlobId(contentId),
    threadId: publicThreadId(threadKey),
    size: raw.byteLength,
  };
}
