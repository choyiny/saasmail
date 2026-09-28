import type { DrizzleD1Database } from "drizzle-orm/d1";
import { inArray, sql, type SQL } from "drizzle-orm";
import { sentEmails } from "../db/sent-emails.schema";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import {
  buildMessageQuerySql,
  countMessages,
  MESSAGE_REFS_PER_QUERY,
  queryMessages,
  type MessageFolder,
  type MessageQuery,
} from "../lib/messages/query";
import {
  serializeMessageRef,
  type AttachmentRow,
  type MessageRef,
  type UnifiedMessage,
} from "../lib/messages/types";
import { parseJmapDate } from "./dates";
import { customMailboxId, systemMailboxId } from "./ids";
import {
  contentEmailObject,
  selectEmailProperties,
  type JmapContentRow,
} from "./content";
import { loadContentRows } from "./sent-content";
import {
  countDrafts,
  draftArmSql,
  draftEmailObject,
  listDrafts,
  loadDraftsByIds,
  type DraftFilter,
} from "./drafts";
import {
  isSystemDescriptor,
  loadMailboxDescriptors,
  type MailboxDescriptor,
} from "./mailboxes";
import {
  parseAnyEmailId,
  parseEmailId,
  publicAttachmentBlobId,
  publicBodyPartBlobId,
  publicDraftEmailId,
  publicEmailId,
  publicReceivedRawBlobId,
  publicThreadId,
} from "./public-ids";
import { currentJmapState } from "./state";
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
  emailId: string,
  partId: "text" | "html",
  value: string,
  type: string,
): Record<string, unknown> {
  return {
    partId,
    blobId: publicBodyPartBlobId(emailId, partId),
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
    blobId: publicAttachmentBlobId(row.id),
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

/**
 * Internal thread key: what queryMessages' `threadKeys` filters on. JMAP-sent
 * mail keeps its content's key (RFC 8621: threadId is immutable), which can
 * differ from the conversation key its Sent row would get naturally.
 */
export function jmapThreadKey(message: UnifiedMessage): string {
  return (
    message.jmap?.threadKey ??
    message.state?.conversationKey ??
    serializeMessageRef(message.ref)
  );
}

export function jmapThreadId(message: UnifiedMessage): string {
  return publicThreadId(jmapThreadKey(message));
}

/**
 * The public id JMAP shows for a message. A Sent row that a submission's
 * on-success step aliased keeps the id of the draft it was sent from (spec
 * §3.3); every other message uses its own reference.
 */
export function jmapMessageId(message: UnifiedMessage): string {
  return message.jmap?.emailId
    ? publicDraftEmailId(message.jmap.emailId)
    : publicEmailId(message.ref);
}

const ALIAS_LOOKUP_CHUNK = 40;

/** Internal draft id -> the Sent row it was aliased onto, if any. */
export async function loadAliasedSentRefs(
  db: DrizzleD1Database<any>,
  draftIds: string[],
): Promise<Map<string, MessageRef>> {
  const refs = new Map<string, MessageRef>();
  const unique = [...new Set(draftIds)];
  for (let start = 0; start < unique.length; start += ALIAS_LOOKUP_CHUNK) {
    const rows = await db
      .select({ id: sentEmails.id, jmapEmailId: sentEmails.jmapEmailId })
      .from(sentEmails)
      .where(
        inArray(
          sentEmails.jmapEmailId,
          unique.slice(start, start + ALIAS_LOOKUP_CHUNK),
        ),
      );
    for (const row of rows) {
      if (row.jmapEmailId) {
        refs.set(row.jmapEmailId, { kind: "sent", id: row.id });
      }
    }
  }
  return refs;
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

export function toJmapEmail(
  message: UnifiedMessage,
  args: Record<string, unknown>,
  content?: JmapContentRow,
): Record<string, unknown> | null {
  const id = jmapMessageId(message);
  if (content) {
    // JMAP-originated Sent mail: immutable properties come from the content
    // (spec §3.3); receivedAt is the send time, or the draft's own receivedAt
    // once the row was aliased; mailboxes and keywords are the Sent row's state.
    return contentEmailObject(
      content,
      {
        id,
        mailboxIds: jmapMailboxIds(message),
        keywords: jmapKeywords(message),
        receivedAt: message.jmap?.receivedAt ?? message.occurredAt,
      },
      args,
    );
  }
  if (message.ref.kind === "sent" && message.from?.name) {
    // The web names a sent message's From after its inbox identity, but `from`
    // and `size` are immutable here, and JMAP has always shown an ordinary Sent
    // Email's From without a name: a client that fetched it never refetches.
    message = { ...message, from: { email: message.from.email } };
  }
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
    // Received mail stored with its raw message has an exact blob and size;
    // older mail keeps null and the approximation it always had.
    blobId:
      message.ref.kind === "received" && message.rawSize !== undefined
        ? publicReceivedRawBlobId(message.ref.id)
        : null,
    threadId: jmapThreadId(message),
    mailboxIds: jmapMailboxIds(message),
    keywords: jmapKeywords(message),
    size: message.rawSize ?? approximateSize(message),
    receivedAt: utcDate(message.occurredAt),
    messageId: messageIds(message.messageId),
    inReplyTo: messageIds(message.inReplyTo),
    references: messageIds(message.references ?? null),
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
  return selectEmailProperties(full, args.properties);
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
    withJmap: true,
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
    const ref = parseEmailId(id);
    if (ref) refsById.set(publicEmailId(ref), ref);
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

  return new Map(messages.map((message) => [jmapMessageId(message), message]));
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
  const builders = new Map<string, () => Record<string, unknown> | null>();

  // JMAP-sent mail projects from its content row; ordinary mail has none.
  const contentFor = async (messages: UnifiedMessage[]) =>
    loadContentRows(
      db,
      messages.flatMap((message) =>
        message.jmap ? [message.jmap.contentId] : [],
      ),
    );
  const project =
    (contents: Map<string, JmapContentRow>) =>
    (message: UnifiedMessage) =>
    (): Record<string, unknown> | null =>
      toJmapEmail(
        message,
        args,
        message.jmap ? contents.get(message.jmap.contentId) : undefined,
      );

  if (ids === undefined || ids === null) {
    const drafts = await listDrafts(
      db,
      allowed,
      userId,
      MAX_OBJECTS_IN_GET + 1,
    );
    const messageCount = await countMessages(db, allowed, {
      ignoreSnooze: true,
      withJmap: true,
    });
    if (messageCount + drafts.length > MAX_OBJECTS_IN_GET) {
      return {
        type: "requestTooLarge",
        description: `Email/get without ids exceeds maxObjectsInGet (${MAX_OBJECTS_IN_GET})`,
      };
    }
    const messages =
      messageCount === 0
        ? []
        : await queryEmailObjects(db, allowed, userId, {
            limit: MAX_OBJECTS_IN_GET,
          });
    requestedIds = [];
    const contents = await contentFor(messages);
    for (const message of messages) {
      const id = jmapMessageId(message);
      requestedIds.push(id);
      builders.set(id, project(contents)(message));
    }
    for (const item of drafts) {
      const id = publicDraftEmailId(item.draft.id);
      requestedIds.push(id);
      builders.set(id, () => draftEmailObject(item, args));
    }
  } else {
    requestedIds = ids as string[];
    const draftIds: string[] = [];
    for (const id of requestedIds) {
      const ref = parseAnyEmailId(id);
      if (ref && ref.kind === "draft") draftIds.push(ref.id);
    }
    const drafts = await loadDraftsByIds(db, allowed, userId, draftIds);
    for (const item of drafts.values()) {
      // Keyed by the canonical public id: a non-canonical spelling stays
      // notFound.
      builders.set(publicDraftEmailId(item.draft.id), () =>
        draftEmailObject(item, args),
      );
    }

    // A D id with no draft row may be a draft that was sent and filed into Sent
    // (the alias). Resolve it to that Sent row; results are keyed by
    // jmapMessageId, so it comes back under the same D id.
    const missingDraftIds = draftIds.filter((id) => !drafts.has(id));
    const aliased = missingDraftIds.length
      ? await loadAliasedSentRefs(db, missingDraftIds)
      : new Map<string, MessageRef>();

    const messages = await loadJmapEmailObjectsByIds(db, allowed, userId, [
      ...requestedIds.filter((id) => {
        const ref = parseAnyEmailId(id);
        return !ref || ref.kind !== "draft";
      }),
      ...[...aliased.values()].map(publicEmailId),
    ]);
    const contents = await contentFor([...messages.values()]);
    for (const [id, message] of messages) {
      builders.set(id, project(contents)(message));
    }
  }

  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of requestedIds) {
    const build = builders.get(id);
    if (!build) {
      notFound.push(id);
      continue;
    }
    const email = build();
    if (!email) return { type: "invalidArguments", properties: ["properties"] };
    list.push(email);
  }

  return { accountId, state, list, notFound };
}

function parseAfter(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = parseJmapDate(value, { utc: true });
  if (parsed === null) return null;
  return Math.floor(parsed / 1000) + 1;
}

function parseBefore(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = parseJmapDate(value, { utc: true });
  if (parsed === null) return null;
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

const QUERY_KEYWORDS = ["$seen", "$flagged", "$draft"];

type KeywordFilter = { seen?: boolean; starred?: boolean; draft?: boolean };

/** null when hasKeyword and notKeyword contradict each other (nothing matches). */
function keywordFilter(filter: Record<string, unknown>): KeywordFilter | null {
  const result: KeywordFilter = {};
  const pairs = [
    [filter.hasKeyword, true],
    [filter.notKeyword, false],
  ] as const;
  for (const [value, wanted] of pairs) {
    if (value === undefined) continue;
    const key =
      value === "$seen" ? "seen" : value === "$flagged" ? "starred" : "draft";
    if (result[key] !== undefined && result[key] !== wanted) return null;
    result[key] = wanted;
  }
  return result;
}

function descriptorDraftRole(
  descriptor: MailboxDescriptor,
): "drafts" | "trash" | null {
  if (!isSystemDescriptor(descriptor)) return null;
  return descriptor.role === "drafts" || descriptor.role === "trash"
    ? descriptor.role
    : null;
}

async function mergedEmailPage(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  messageQuery: MessageQuery | null,
  draftFilter: DraftFilter | null,
  position: number,
  limit: number,
): Promise<string[]> {
  const window = position + limit;
  const arms: SQL[] = [];
  if (messageQuery) {
    const built = buildMessageQuerySql(allowed, {
      ...messageQuery,
      offset: 0,
      limit: window,
    });
    if (built) {
      arms.push(
        sql`SELECT kind, id, occurred_at, jmap_email_id FROM (${built.statement})`,
      );
    }
  }
  if (draftFilter) {
    arms.push(
      sql`SELECT kind, id, occurred_at, NULL AS jmap_email_id FROM (${draftArmSql(allowed, userId, draftFilter, window + 1)})`,
    );
  }
  if (arms.length === 0) return [];
  // Each arm already holds its top `window` rows, so the merged top window is
  // exact.
  const rows = await db.all<{
    kind: string;
    id: string;
    occurred_at: number;
    jmap_email_id: string | null;
  }>(sql`
    SELECT kind, id, occurred_at, jmap_email_id FROM (${sql.join(arms, sql` UNION ALL `)})
     ORDER BY occurred_at DESC, id DESC, kind ASC
     LIMIT ${limit} OFFSET ${position}
  `);
  return rows.map((row) => {
    // A Sent row a submission aliased onto its draft is that Email, not a
    // second `S…` (spec §3.3).
    if (row.jmap_email_id) return publicDraftEmailId(row.jmap_email_id);
    return row.kind === "draft"
      ? publicDraftEmailId(row.id)
      : publicEmailId({
          kind: row.kind === "sent" ? "sent" : "received",
          id: row.id,
        });
  });
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

  for (const value of [filter.hasKeyword, filter.notKeyword]) {
    if (
      value !== undefined &&
      (typeof value !== "string" || !QUERY_KEYWORDS.includes(value))
    ) {
      return { type: "invalidArguments", properties: ["filter"] };
    }
  }
  const keywords = keywordFilter(filter);

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

  let messagesImpossible = keywords === null || keywords.draft === true;
  let draftsImpossible = keywords === null || keywords.draft === false;
  let messageQuery: MessageQuery = {
    order: "desc",
    ignoreSnooze: true,
    withJmap: true,
    viewer: { userId },
    ...(typeof filter.text === "string"
      ? { search: filter.text, searchMode: "fulltext" as const }
      : {}),
    ...(typeof filter.from === "string" ? { from: filter.from } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(keywords && keywords.seen !== undefined ? { seen: keywords.seen } : {}),
    ...(keywords && keywords.starred !== undefined
      ? { starred: keywords.starred }
      : {}),
  };
  const draftFilter: DraftFilter = {
    ...(typeof filter.text === "string" ? { text: filter.text } : {}),
    ...(typeof filter.from === "string" ? { from: filter.from } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(keywords && keywords.seen !== undefined ? { seen: keywords.seen } : {}),
    ...(keywords && keywords.starred !== undefined
      ? { flagged: keywords.starred }
      : {}),
  };

  if (typeof filter.inMailbox === "string") {
    const descriptors = await loadMailboxDescriptors(db, allowed);
    const descriptor = descriptors.find((item) => item.id === filter.inMailbox);
    if (!descriptor) {
      messagesImpossible = true;
      draftsImpossible = true;
    } else {
      const folder = descriptorFolder(descriptor);
      if (!folder) messagesImpossible = true;
      else
        messageQuery = { ...messageQuery, inboxes: [descriptor.inbox], folder };
      const role = descriptorDraftRole(descriptor);
      if (descriptor.kind === "custom") {
        // The author's drafts filed in this folder.
        draftFilter.inbox = descriptor.inbox;
        draftFilter.mailboxId = descriptor.mailboxId;
      } else if (!role) draftsImpossible = true;
      else {
        draftFilter.inbox = descriptor.inbox;
        draftFilter.role = role;
      }
    }
  }

  const queryState = (await currentJmapState(db, allowed, userId)).state;
  let total: number | undefined;
  if (position < 0 || args.calculateTotal === true) {
    total =
      (messagesImpossible
        ? 0
        : await countMessages(db, allowed, messageQuery)) +
      (draftsImpossible
        ? 0
        : await countDrafts(db, allowed, userId, draftFilter));
  }
  const resolvedPosition =
    position < 0 ? Math.max(0, (total ?? 0) + position) : position;

  let ids: string[] = [];
  if (limit > 0 && (!messagesImpossible || !draftsImpossible)) {
    ids = await mergedEmailPage(
      db,
      allowed,
      userId,
      messagesImpossible ? null : messageQuery,
      draftsImpossible ? null : draftFilter,
      resolvedPosition,
      limit,
    );
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
