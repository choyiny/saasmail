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
  type MailAddress,
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
  type DraftExclusion,
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
import { MAX_OBJECTS_IN_GET, MAX_QUERY_RESULTS } from "./constants";
import { emailChangesSince } from "./changes";

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

/**
 * JMAP `to`: received mail's To header as stored (the inbox alone for mail
 * stored without one); a sent message's To and any further To.
 */
function toAddresses(message: UnifiedMessage): MailAddress[] {
  if (message.toList) return message.toList;
  if (message.ref.kind === "received") return [message.to];
  return [message.to, ...(message.additionalTo ?? [])];
}

function approximateSize(message: UnifiedMessage): number {
  const addressBytes = [
    message.from?.email,
    message.from?.name,
    ...[...toAddresses(message), ...message.cc, ...(message.bcc ?? [])].flatMap(
      (address) => [address.email, address.name],
    ),
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
    to: toAddresses(message).map((address) => emailAddress(address)),
    cc: message.cc.map((address) => emailAddress(address)),
    bcc:
      message.bcc && message.bcc.length > 0
        ? message.bcc.map((address) => emailAddress(address))
        : null,
    // Received mail's Reply-To (docs/inboxes.md); exposed with the epoch reset
    // that header threading brought, since `replyTo` is immutable.
    replyTo:
      message.replyTo && message.replyTo.length > 0
        ? message.replyTo.map((address) => emailAddress(address))
        : null,
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
    withReplyTo: true,
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
    "inMailboxOtherThan",
    "text",
    "subject",
    "body",
    "from",
    "after",
    "before",
    "hasKeyword",
    "notKeyword",
  ]);
  return Object.keys(filter).every((key) => allowed.has(key));
}

type FlattenedFilter = {
  condition: Record<string, unknown> | null;
  error: JmapMethodError | null;
};

/**
 * One FilterCondition for a filter (RFC 8620 §5.5): an AND whose conditions
 * flatten, recursively, into one condition naming no property twice is that
 * condition, and any operator but NOT over a single condition is that
 * condition. Anything else (OR, NOT, a repeated property) can't be one
 * condition and is `unsupportedFilter`.
 */
function flattenFilter(value: unknown): FlattenedFilter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      condition: null,
      error: { type: "invalidArguments", properties: ["filter"] },
    };
  }
  const filter = value as Record<string, unknown>;
  if (!("operator" in filter)) return { condition: filter, error: null };

  const { operator, conditions } = filter;
  if (
    (operator !== "AND" && operator !== "OR" && operator !== "NOT") ||
    !Array.isArray(conditions) ||
    Object.keys(filter).some(
      (key) => key !== "operator" && key !== "conditions",
    )
  ) {
    return {
      condition: null,
      error: { type: "invalidArguments", properties: ["filter"] },
    };
  }
  if (conditions.length === 1 && operator !== "NOT") {
    return flattenFilter(conditions[0]);
  }
  if (operator !== "AND") {
    return { condition: null, error: { type: "unsupportedFilter" } };
  }

  const merged: Record<string, unknown> = {};
  for (const condition of conditions) {
    const flattened = flattenFilter(condition);
    if (flattened.error) return flattened;
    for (const [key, property] of Object.entries(
      flattened.condition as Record<string, unknown>,
    )) {
      if (key in merged) {
        return { condition: null, error: { type: "unsupportedFilter" } };
      }
      merged[key] = property;
    }
  }
  return { condition: merged, error: null };
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

/** Strict mode is off: the query, or the method error (`error` null on success). */
type EmailQueryPlan = {
  messageQuery: MessageQuery;
  draftFilter: DraftFilter;
  messagesImpossible: boolean;
  draftsImpossible: boolean;
  /** Mailbox ids the filter names, resolved by `resolveMailboxFilters`. */
  inMailbox?: string;
  inMailboxOtherThan?: string[];
};

type ParsedEmailQuery = {
  query: EmailQueryPlan | null;
  error: JmapMethodError | null;
};

function parseFailure(error: JmapMethodError): ParsedEmailQuery {
  return { query: null, error };
}

/**
 * `Email/query` and `Email/queryChanges` arguments other than the window:
 * collapseThreads, calculateTotal, sort and filter. Validation only, no
 * database: the mailboxes the filter names are resolved by
 * `resolveMailboxFilters`, after the caller has read its state.
 */
function parseEmailQuery(
  userId: string,
  args: Record<string, unknown>,
): ParsedEmailQuery {
  if (args.collapseThreads !== undefined && args.collapseThreads !== false) {
    return parseFailure({
      type: "invalidArguments",
      properties: ["collapseThreads"],
    });
  }
  if (
    args.calculateTotal !== undefined &&
    typeof args.calculateTotal !== "boolean"
  ) {
    return parseFailure({
      type: "invalidArguments",
      properties: ["calculateTotal"],
    });
  }

  if (args.sort !== undefined && args.sort !== null) {
    if (!Array.isArray(args.sort) || args.sort.length !== 1) {
      return parseFailure({ type: "unsupportedSort" });
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
      return parseFailure({ type: "unsupportedSort" });
    }
  }

  const flattened = flattenFilter(args.filter ?? {});
  if (flattened.error) return parseFailure(flattened.error);
  const filter = flattened.condition as Record<string, unknown>;
  if (!hasOnlySupportedFilterFields(filter)) {
    return parseFailure({ type: "invalidArguments", properties: ["filter"] });
  }

  for (const stringField of [
    "inMailbox",
    "text",
    "subject",
    "body",
    "from",
  ] as const) {
    if (
      filter[stringField] !== undefined &&
      typeof filter[stringField] !== "string"
    ) {
      return parseFailure({ type: "invalidArguments", properties: ["filter"] });
    }
  }
  const otherThan = filter.inMailboxOtherThan;
  if (
    otherThan !== undefined &&
    (!Array.isArray(otherThan) ||
      !otherThan.every((id) => typeof id === "string"))
  ) {
    return parseFailure({ type: "invalidArguments", properties: ["filter"] });
  }
  // One search per query: each arm has one search predicate.
  if (
    ["text", "subject", "body"].filter((key) => filter[key] !== undefined)
      .length > 1
  ) {
    return parseFailure({ type: "unsupportedFilter" });
  }

  for (const value of [filter.hasKeyword, filter.notKeyword]) {
    if (
      value !== undefined &&
      (typeof value !== "string" || !QUERY_KEYWORDS.includes(value))
    ) {
      return parseFailure({ type: "invalidArguments", properties: ["filter"] });
    }
  }
  const keywords = keywordFilter(filter);

  const after = parseAfter(filter.after);
  const before = parseBefore(filter.before);
  if (after === null || before === null) {
    return parseFailure({ type: "invalidArguments", properties: ["filter"] });
  }

  const search =
    typeof filter.text === "string"
      ? { search: filter.text, searchMode: "fulltext" as const }
      : typeof filter.subject === "string"
        ? { search: filter.subject, searchMode: "subject" as const }
        : typeof filter.body === "string"
          ? { search: filter.body, searchMode: "body" as const }
          : {};

  let messagesImpossible = keywords === null || keywords.draft === true;
  let draftsImpossible = keywords === null || keywords.draft === false;
  let messageQuery: MessageQuery = {
    order: "desc",
    ignoreSnooze: true,
    withJmap: true,
    viewer: { userId },
    ...search,
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
    ...(typeof filter.subject === "string" ? { subject: filter.subject } : {}),
    ...(typeof filter.body === "string" ? { body: filter.body } : {}),
    ...(typeof filter.from === "string" ? { from: filter.from } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(keywords && keywords.seen !== undefined ? { seen: keywords.seen } : {}),
    ...(keywords && keywords.starred !== undefined
      ? { flagged: keywords.starred }
      : {}),
  };

  return {
    query: {
      messageQuery,
      draftFilter,
      messagesImpossible,
      draftsImpossible,
      ...(typeof filter.inMailbox === "string"
        ? { inMailbox: filter.inMailbox }
        : {}),
      ...(otherThan !== undefined
        ? { inMailboxOtherThan: otherThan as string[] }
        : {}),
    },
    error: null,
  };
}

/**
 * The plan with the mailboxes its filter names resolved. Read after the
 * state: a mailbox (and mail in it) created in between is then in the next
 * call's changes, never folded into a state this answer already reported.
 */
async function resolveMailboxFilters(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  plan: EmailQueryPlan,
): Promise<EmailQueryPlan> {
  const otherThan = plan.inMailboxOtherThan;
  if (plan.inMailbox === undefined && otherThan === undefined) return plan;
  let { messageQuery, messagesImpossible, draftsImpossible } = plan;
  const draftFilter: DraftFilter = { ...plan.draftFilter };
  const descriptors = await loadMailboxDescriptors(db, allowed);

  if (plan.inMailbox !== undefined) {
    const descriptor = descriptors.find((item) => item.id === plan.inMailbox);
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

  if (otherThan !== undefined) {
    // Unknown ids name no mailbox, so they exclude nothing.
    const excluded = new Set(otherThan);
    const excludeFolders: NonNullable<MessageQuery["excludeFolders"]> = [];
    const exclude: DraftExclusion[] = [];
    for (const descriptor of descriptors) {
      if (!excluded.has(descriptor.id)) continue;
      const folder = descriptorFolder(descriptor);
      if (folder) excludeFolders.push({ inbox: descriptor.inbox, folder });
      if (descriptor.kind === "custom") {
        exclude.push({
          inbox: descriptor.inbox,
          mailboxId: descriptor.mailboxId,
        });
      } else {
        const role = descriptorDraftRole(descriptor);
        if (role) exclude.push({ inbox: descriptor.inbox, role });
      }
    }
    if (excludeFolders.length > 0) {
      messageQuery = { ...messageQuery, excludeFolders };
    }
    if (exclude.length > 0) draftFilter.exclude = exclude;
  }

  return { messageQuery, draftFilter, messagesImpossible, draftsImpossible };
}

/** Ids of the query's results from `position`, at most `limit` of them. */
async function emailQueryIds(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  query: EmailQueryPlan,
  position: number,
  limit: number,
): Promise<string[]> {
  if (limit <= 0 || (query.messagesImpossible && query.draftsImpossible)) {
    return [];
  }
  return mergedEmailPage(
    db,
    allowed,
    userId,
    query.messagesImpossible ? null : query.messageQuery,
    query.draftsImpossible ? null : query.draftFilter,
    position,
    limit,
  );
}

/**
 * `Email/query`. `ceiling` is the largest page (`MAX_QUERY_RESULTS`; tests pass
 * a small one): without a limit, or with a larger one, the page is the ceiling
 * and the response says so (RFC 8620 §5.5).
 */
export async function emailQuery(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
  ceiling = MAX_QUERY_RESULTS,
): Promise<Record<string, unknown> | JmapMethodError> {
  const parsed = parseEmailQuery(userId, args);
  if (parsed.error) return parsed.error;

  const position = args.position ?? 0;
  const requestedLimit = args.limit ?? null;
  if (
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    (requestedLimit !== null &&
      (typeof requestedLimit !== "number" ||
        !Number.isInteger(requestedLimit) ||
        requestedLimit < 0))
  ) {
    return { type: "invalidArguments", properties: ["position", "limit"] };
  }
  const limitCapped =
    requestedLimit === null || (requestedLimit as number) > ceiling;
  const limit = limitCapped ? ceiling : (requestedLimit as number);

  // The state first, then everything the answer is computed from.
  const queryState = (await currentJmapState(db, allowed, userId)).state;
  const query = await resolveMailboxFilters(
    db,
    allowed,
    parsed.query as EmailQueryPlan,
  );
  let total: number | undefined;
  if (position < 0 || args.calculateTotal === true) {
    total =
      (query.messagesImpossible
        ? 0
        : await countMessages(db, allowed, query.messageQuery)) +
      (query.draftsImpossible
        ? 0
        : await countDrafts(db, allowed, userId, query.draftFilter));
  }
  const resolvedPosition =
    position < 0 ? Math.max(0, (total ?? 0) + position) : position;

  // One extra row says whether the page is the whole result.
  const page = await emailQueryIds(
    db,
    allowed,
    userId,
    query,
    resolvedPosition,
    limit === 0 ? 0 : limit + 1,
  );
  const ids = page.slice(0, limit);
  const wholeResultFits =
    total !== undefined
      ? total <= ceiling
      : resolvedPosition === 0 && limit > 0 && page.length <= limit;

  const result: Record<string, unknown> = {
    accountId,
    queryState,
    // Email/queryChanges diffs the whole result, so only a result that fits
    // the ceiling can be diffed.
    canCalculateChanges: wholeResultFits,
    position: resolvedPosition,
    ids,
  };
  if (args.calculateTotal === true) {
    result.total = total;
  }
  if (limitCapped) result.limit = limit;
  return result;
}

/**
 * `Email/queryChanges` (RFC 8620 §5.6). The current state is read first, then
 * the change log and the results, so a write landing in between is reported
 * again by the next call rather than missed. Every Email changed since the
 * state is in `removed` unless it was created since (it can't have been in the
 * old results); every changed Email in the current results is in `added`.
 */
export async function emailQueryChanges(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
  ceiling = MAX_QUERY_RESULTS,
): Promise<Record<string, unknown> | JmapMethodError> {
  const parsed = parseEmailQuery(userId, args);
  if (parsed.error) return parsed.error;

  const maxChanges = args.maxChanges ?? null;
  if (
    maxChanges !== null &&
    (typeof maxChanges !== "number" ||
      !Number.isInteger(maxChanges) ||
      maxChanges <= 0)
  ) {
    return { type: "invalidArguments", properties: ["maxChanges"] };
  }
  // Only meaningful for immutable filters and sorts; ours can match on
  // keywords and mailboxes, so it is accepted and ignored.
  if (
    args.upToId !== undefined &&
    args.upToId !== null &&
    typeof args.upToId !== "string"
  ) {
    return { type: "invalidArguments", properties: ["upToId"] };
  }

  const changes = await emailChangesSince(
    db,
    allowed,
    userId,
    args.sinceQueryState,
  );
  if (changes.error) return changes.error;
  const since = changes.changes as NonNullable<typeof changes.changes>;

  // Mailboxes resolve after the state (read first, in emailChangesSince).
  const query = await resolveMailboxFilters(
    db,
    allowed,
    parsed.query as EmailQueryPlan,
  );
  const ids = await emailQueryIds(db, allowed, userId, query, 0, ceiling + 1);
  if (ids.length > ceiling) return { type: "cannotCalculateChanges" };

  const indexById = new Map(ids.map((id, index) => [id, index]));
  const removed = since.touchedIds;
  const added = [...new Set([...since.createdIds, ...since.touchedIds])]
    .filter((id) => indexById.has(id))
    .map((id) => ({ id, index: indexById.get(id) as number }))
    .sort((left, right) => left.index - right.index);
  if (
    maxChanges !== null &&
    removed.length + added.length > (maxChanges as number)
  ) {
    return { type: "tooManyChanges" };
  }

  const result: Record<string, unknown> = {
    accountId,
    oldQueryState: args.sinceQueryState as string,
    newQueryState: since.newState,
    removed,
    added,
  };
  if (args.calculateTotal === true) result.total = ids.length;
  return result;
}
