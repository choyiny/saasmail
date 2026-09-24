import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import {
  countMessages,
  MESSAGE_REFS_PER_QUERY,
  queryMessages,
  type MessageFolder,
  type MessageQuery,
} from "../lib/messages/query";
import {
  parseMessageRef,
  serializeMessageRef,
  type AttachmentRow,
  type MessageRef,
  type UnifiedMessage,
} from "../lib/messages/types";
import { customMailboxId, systemMailboxId } from "./ids";
import { loadMailboxDescriptors, type MailboxDescriptor } from "./mailboxes";
import { currentJmapState, jmapState } from "./state";
import { MAX_OBJECTS_IN_GET } from "./constants";

export type JmapMethodError = {
  type: string;
  description?: string;
  properties?: string[];
};

function byteLength(value: string | null | undefined): number {
  return value ? new TextEncoder().encode(value).byteLength : 0;
}

function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function bodyPart(
  messageId: string,
  partId: "text" | "html",
  value: string,
  type: string,
): Record<string, unknown> {
  return {
    partId,
    blobId: `body-${encodeURIComponent(messageId)}-${partId}`,
    size: byteLength(value),
    name: null,
    type,
    charset: "utf-8",
    disposition: null,
    cid: null,
    language: null,
    location: null,
  };
}

function attachmentPart(row: AttachmentRow): Record<string, unknown> {
  return {
    partId: `att-${row.id}`,
    blobId: row.id,
    size: row.size,
    name: row.filename,
    type: row.contentType,
    charset: null,
    disposition: "attachment",
    cid: row.contentId,
    language: null,
    location: null,
  };
}

export function jmapThreadId(message: UnifiedMessage): string {
  return message.state?.conversationKey ?? serializeMessageRef(message.ref);
}

function systemMailboxForMessage(message: UnifiedMessage): string | null {
  const state = message.state;
  const inbox = message.inbox.toLowerCase();

  if (state?.trashedAt) return systemMailboxId(inbox, "trash");
  if (message.direction === "outbound") return systemMailboxId(inbox, "sent");
  if (state?.spamAt) return systemMailboxId(inbox, "junk");
  if (state?.archivedAt) return systemMailboxId(inbox, "archive");
  return systemMailboxId(inbox, "inbox");
}

export function jmapMailboxIds(message: UnifiedMessage): Record<string, true> {
  const ids: Record<string, true> = {};
  const system = systemMailboxForMessage(message);
  if (system) ids[system] = true;
  for (const mailboxId of message.state?.mailboxIds ?? []) {
    ids[customMailboxId(mailboxId)] = true;
  }
  return ids;
}

export function jmapKeywords(message: UnifiedMessage): Record<string, true> {
  const result: Record<string, true> = {};
  if (message.state?.seen) result.$seen = true;
  if (message.state?.starredAt) result.$flagged = true;
  return result;
}

function emailAddress(
  address: { email: string; name?: string | null } | null,
): Record<string, unknown> | null {
  if (!address) return null;
  return { email: address.email, name: address.name ?? null };
}

function bodyValues(
  message: UnifiedMessage,
  fetchText: boolean,
  fetchHtml: boolean,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (fetchText && message.bodyText !== null) {
    values.text = {
      value: message.bodyText,
      isEncodingProblem: false,
      isTruncated: false,
    };
  }
  if (fetchHtml && message.bodyHtml !== null) {
    values.html = {
      value: message.bodyHtml,
      isEncodingProblem: false,
      isTruncated: false,
    };
  }
  return values;
}

function approximateSize(message: UnifiedMessage): number {
  const addressBytes = [
    message.from?.email,
    message.from?.name,
    message.to.email,
    message.to.name,
    ...message.cc.flatMap((address) => [address.email, address.name]),
  ].reduce<number>((sum, value) => sum + byteLength(value), 0);
  const attachmentBytes = (message.attachments ?? []).reduce(
    (sum, attachment) => sum + attachment.size,
    0,
  );
  return (
    byteLength(message.subject) +
    byteLength(message.bodyText) +
    byteLength(message.bodyHtml) +
    addressBytes +
    attachmentBytes
  );
}

const EMAIL_PROPERTIES = new Set([
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  "bodyStructure",
  "headers",
]);

const EMAIL_HEADER_FORMS = new Set([
  "asRaw",
  "asText",
  "asAddresses",
  "asGroupedAddresses",
  "asMessageIds",
  "asDate",
  "asURLs",
]);

function validHeaderName(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (!((code >= 33 && code <= 57) || (code >= 59 && code <= 126))) {
      return false;
    }
  }
  return true;
}

function validHeaderProperty(property: string): boolean {
  const parts = property.split(":");
  if (parts[0] !== "header" || parts.length < 2 || parts.length > 4) {
    return false;
  }
  if (!validHeaderName(parts[1]!)) return false;

  let index = 2;
  if (index < parts.length && parts[index] !== "all") {
    if (!EMAIL_HEADER_FORMS.has(parts[index]!)) return false;
    index += 1;
  }
  if (index < parts.length) {
    if (parts[index] !== "all") return false;
    index += 1;
  }
  return index === parts.length;
}

function validEmailProperties(properties: unknown): boolean {
  return (
    properties === undefined ||
    properties === null ||
    (Array.isArray(properties) &&
      properties.every(
        (property) =>
          typeof property === "string" &&
          (EMAIL_PROPERTIES.has(property) || validHeaderProperty(property)),
      ))
  );
}

function messageIds(value: string | null): string[] | null {
  if (!value) return null;
  const ids = value
    .split(/\s+/)
    .map((part) =>
      part.startsWith("<") && part.endsWith(">") ? part.slice(1, -1) : part,
    )
    .filter((part) => part.length > 0);
  return ids.length > 0 ? ids : null;
}

function supportedProperties(
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

export function toJmapEmail(
  message: UnifiedMessage,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const id = serializeMessageRef(message.ref);
  const attachments = message.attachments ?? [];
  const textBody = message.bodyText
    ? [bodyPart(id, "text", message.bodyText, "text/plain")]
    : [];
  const htmlBody = message.bodyHtml
    ? [bodyPart(id, "html", message.bodyHtml, "text/html")]
    : [];
  const preview = (message.bodyText ?? "").slice(0, 256);
  const from = emailAddress(message.from);
  const full: Record<string, unknown> = {
    id,
    blobId: null,
    threadId: jmapThreadId(message),
    mailboxIds: jmapMailboxIds(message),
    keywords: jmapKeywords(message),
    size: approximateSize(message),
    receivedAt: utcDate(message.occurredAt),
    messageId: messageIds(message.messageId),
    inReplyTo: messageIds(message.inReplyTo),
    references: null,
    sender: null,
    from: from ? [from] : [],
    to: [emailAddress(message.to)],
    cc: message.cc.map((address) => emailAddress(address)),
    bcc: null,
    replyTo: null,
    subject: message.subject ?? "",
    sentAt:
      message.direction === "outbound" ? utcDate(message.occurredAt) : null,
    hasAttachment: attachments.length > 0,
    preview,
    bodyValues: bodyValues(
      message,
      args.fetchTextBodyValues === true,
      args.fetchHTMLBodyValues === true,
    ),
    textBody,
    htmlBody,
    attachments: attachments.map(attachmentPart),
    bodyStructure: null,
    headers: null,
  };
  return supportedProperties(full, args.properties);
}

async function queryEmailObjects(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  query: MessageQuery,
): Promise<UnifiedMessage[]> {
  const page = await queryMessages(db, allowed, {
    ...query,
    ignoreSnooze: true,
    viewer: { userId },
    withState: true,
    withAttachments: true,
  });
  return page.messages;
}

export async function loadJmapEmailObjectsByIds(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  ids: string[],
): Promise<Map<string, UnifiedMessage>> {
  const refsById = new Map<string, MessageRef>();
  for (const id of ids) {
    const ref = parseMessageRef(id);
    if (ref) refsById.set(serializeMessageRef(ref), ref);
  }

  const messages: UnifiedMessage[] = [];
  const refs = [...refsById.values()];
  for (let start = 0; start < refs.length; start += MESSAGE_REFS_PER_QUERY) {
    const chunk = refs.slice(start, start + MESSAGE_REFS_PER_QUERY);
    messages.push(
      ...(await queryEmailObjects(db, allowed, userId, {
        messageRefs: chunk,
        limit: chunk.length,
      })),
    );
  }

  return new Map(
    messages.map((message) => [serializeMessageRef(message.ref), message]),
  );
}

export async function emailGet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  if (!validEmailProperties(args.properties)) {
    return { type: "invalidArguments", properties: ["properties"] };
  }

  const ids = args.ids;
  if (
    ids !== undefined &&
    ids !== null &&
    (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
  ) {
    return { type: "invalidArguments", properties: ["ids"] };
  }
  if (Array.isArray(ids) && ids.length > MAX_OBJECTS_IN_GET) {
    return {
      type: "requestTooLarge",
      description: `ids exceeds maxObjectsInGet (${MAX_OBJECTS_IN_GET})`,
    };
  }

  const state = (await currentJmapState(db, allowed, userId)).state;
  let requestedIds: string[];
  let messages: UnifiedMessage[];

  if (ids === undefined || ids === null) {
    const count = await countMessages(db, allowed, { ignoreSnooze: true });
    if (count > MAX_OBJECTS_IN_GET) {
      return {
        type: "requestTooLarge",
        description: `Email/get without ids exceeds maxObjectsInGet (${MAX_OBJECTS_IN_GET})`,
      };
    }
    messages =
      count === 0
        ? []
        : await queryEmailObjects(db, allowed, userId, {
            limit: MAX_OBJECTS_IN_GET,
          });
    requestedIds = messages.map((message) => serializeMessageRef(message.ref));
  } else {
    requestedIds = ids as string[];
    messages = [
      ...(
        await loadJmapEmailObjectsByIds(db, allowed, userId, requestedIds)
      ).values(),
    ];
  }

  const byId = new Map(
    messages.map((message) => [serializeMessageRef(message.ref), message]),
  );
  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of requestedIds) {
    const message = byId.get(id);
    if (!message) {
      notFound.push(id);
      continue;
    }
    const email = toJmapEmail(message, args);
    if (!email) return { type: "invalidArguments", properties: ["properties"] };
    list.push(email);
  }

  return {
    accountId,
    state,
    list,
    notFound,
  };
}

function parseAfter(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000) + 1;
}

function parseBefore(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.ceil(parsed / 1000) - 1;
}

function hasOnlySupportedFilterFields(
  filter: Record<string, unknown>,
): boolean {
  const allowed = new Set([
    "inMailbox",
    "text",
    "from",
    "after",
    "before",
    "hasKeyword",
    "notKeyword",
  ]);
  return Object.keys(filter).every((key) => allowed.has(key));
}

function descriptorFolder(descriptor: MailboxDescriptor): MessageFolder | null {
  if (descriptor.kind === "custom") {
    return { mailboxId: descriptor.mailboxId };
  }
  if (descriptor.role === "drafts") return null;
  return descriptor.role;
}

function keywordQuery(
  filter: Record<string, unknown>,
): Pick<MessageQuery, "seen" | "starred"> | null {
  const result: Pick<MessageQuery, "seen" | "starred"> = {};
  const pairs = [
    [filter.hasKeyword, true],
    [filter.notKeyword, false],
  ] as const;

  for (const [value, wanted] of pairs) {
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      (value !== "$seen" && value !== "$flagged")
    ) {
      return null;
    }
    if (value === "$seen") {
      if (result.seen !== undefined && result.seen !== wanted) return null;
      result.seen = wanted;
    } else {
      if (result.starred !== undefined && result.starred !== wanted)
        return null;
      result.starred = wanted;
    }
  }
  return result;
}

export async function emailQuery(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  if (args.collapseThreads !== undefined && args.collapseThreads !== false) {
    return { type: "invalidArguments", properties: ["collapseThreads"] };
  }
  if (
    args.calculateTotal !== undefined &&
    typeof args.calculateTotal !== "boolean"
  ) {
    return { type: "invalidArguments", properties: ["calculateTotal"] };
  }

  if (args.sort !== undefined && args.sort !== null) {
    if (!Array.isArray(args.sort) || args.sort.length !== 1) {
      return { type: "unsupportedSort" };
    }
    const comparator = args.sort[0];
    if (
      typeof comparator !== "object" ||
      comparator === null ||
      (comparator as Record<string, unknown>).property !== "receivedAt" ||
      (comparator as Record<string, unknown>).isAscending === true ||
      ((comparator as Record<string, unknown>).collation !== undefined &&
        (comparator as Record<string, unknown>).collation !== null)
    ) {
      return { type: "unsupportedSort" };
    }
  }

  const filterValue = args.filter ?? {};
  if (
    typeof filterValue !== "object" ||
    filterValue === null ||
    Array.isArray(filterValue)
  ) {
    return { type: "invalidArguments", properties: ["filter"] };
  }
  const filter = filterValue as Record<string, unknown>;
  if (!hasOnlySupportedFilterFields(filter)) {
    return { type: "invalidArguments", properties: ["filter"] };
  }

  for (const stringField of ["inMailbox", "text", "from"] as const) {
    if (
      filter[stringField] !== undefined &&
      typeof filter[stringField] !== "string"
    ) {
      return { type: "invalidArguments", properties: ["filter"] };
    }
  }

  const keywords = keywordQuery(filter);
  if (
    keywords === null &&
    (filter.hasKeyword !== undefined || filter.notKeyword !== undefined)
  ) {
    const validKeywords = ["$seen", "$flagged"];
    const values = [filter.hasKeyword, filter.notKeyword].filter(
      (value): value is string => typeof value === "string",
    );
    if (values.some((value) => !validKeywords.includes(value))) {
      return { type: "invalidArguments", properties: ["filter"] };
    }
  }

  const after = parseAfter(filter.after);
  const before = parseBefore(filter.before);
  if (after === null || before === null) {
    return { type: "invalidArguments", properties: ["filter"] };
  }

  const position = args.position === undefined ? 0 : args.position;
  const requestedLimit =
    args.limit === undefined ? MAX_OBJECTS_IN_GET : args.limit;
  if (
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    typeof requestedLimit !== "number" ||
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 0
  ) {
    return { type: "invalidArguments", properties: ["position", "limit"] };
  }
  const limit = Math.min(requestedLimit, MAX_OBJECTS_IN_GET);

  let queryExtra: MessageQuery = {
    order: "desc",
    ignoreSnooze: true,
    offset: position,
    limit: Math.max(limit, 1),
    viewer: { userId },
    ...(typeof filter.text === "string"
      ? { search: filter.text, searchMode: "fulltext" as const }
      : {}),
    ...(typeof filter.from === "string" ? { from: filter.from } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(keywords ?? {}),
  };

  let impossible = keywords === null;
  if (typeof filter.inMailbox === "string") {
    const descriptors = await loadMailboxDescriptors(db, allowed);
    const descriptor = descriptors.find((item) => item.id === filter.inMailbox);
    if (!descriptor) {
      impossible = true;
    } else {
      const folder = descriptorFolder(descriptor);
      if (!folder) {
        impossible = true;
      } else {
        queryExtra = {
          ...queryExtra,
          inboxes: [descriptor.inbox],
          folder,
        };
      }
    }
  }

  const queryState = await jmapState(db, allowed, userId);
  let total: number | undefined;
  if (position < 0 || args.calculateTotal === true) {
    total = impossible
      ? 0
      : await countMessages(db, allowed, {
          ...queryExtra,
          limit: undefined,
          offset: undefined,
        });
  }

  const resolvedPosition =
    position < 0 ? Math.max(0, (total ?? 0) + position) : position;
  queryExtra = { ...queryExtra, offset: resolvedPosition };

  let ids: string[] = [];
  if (!impossible && limit > 0) {
    const page = await queryMessages(db, allowed, queryExtra);
    ids = page.messages.map((message) => serializeMessageRef(message.ref));
  }

  const result: Record<string, unknown> = {
    accountId,
    queryState,
    canCalculateChanges: false,
    position: resolvedPosition,
    ids,
  };
  if (args.calculateTotal === true) {
    result.total = total;
  }
  return result;
}
