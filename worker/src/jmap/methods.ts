import type { DrizzleD1Database } from "drizzle-orm/d1";
import { createEmailSender, type EmailSender } from "../lib/email-sender";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import {
  queryMessages,
  queryMessageThreadKeys,
  MESSAGE_REFS_PER_QUERY,
  THREAD_KEYS_PER_QUERY,
} from "../lib/messages/query";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  MAX_CALLS_IN_REQUEST,
  MAX_DELAYED_SEND,
  MAX_OBJECTS_IN_GET,
  MAX_OBJECTS_IN_SET,
  MAX_SIZE_REQUEST,
  SUBMISSION_CAPABILITY,
} from "./constants";
import type { CreatedIds } from "./creation-refs";
import {
  emailGet,
  emailQuery,
  jmapMessageId,
  jmapThreadKey,
  type JmapMethodError,
} from "./emails";
import { listJmapMailboxes, listUsableIdentities } from "./mailboxes";
import { draftThreadMembers, listDraftThreadKeys } from "./drafts";
import { emailChanges, mailboxChanges, submissionChanges } from "./changes";
import { emailSet } from "./email-set";
import { emailSubmissionSet } from "./submission";
import { isMethodError } from "./on-success";
import { emailSubmissionGet, emailSubmissionQuery } from "./submission-read";
import {
  listContentThreadKeys,
  loadContentKeyedSentRefs,
} from "./sent-content";
import {
  parseThreadId,
  publicAccountId,
  publicDraftEmailId,
  publicEmailId,
  publicIdentityId,
  publicThreadId,
} from "./public-ids";
import { currentJmapState, identityState, sessionState } from "./state";

const MAX_EMAILS_IN_THREAD_GET = 1024;

export type MethodResult =
  | {
      ok: true;
      name: string;
      result: Record<string, unknown>;
      /**
       * Responses the method owes the caller under the SAME call id, after its
       * own (RFC 8621 §7.5's implicit Email/set).
       */
      followUps?: { name: string; result: Record<string, unknown> }[];
    }
  | { ok: false; error: Record<string, unknown> };

/** Per-request state every method can use. */
export type JmapMethodContext = {
  env: CloudflareBindings;
  /** Creation id -> server id for this request (RFC 8620 §3.3). */
  createdIds: CreatedIds;
  /** Test seam: the provider EmailSubmission sends through. Defaults to createEmailSender(env). */
  sender?: EmailSender;
};

function methodError(
  type: string,
  description?: string,
  properties?: string[],
): MethodResult {
  return {
    ok: false,
    error: {
      type,
      ...(description ? { description } : {}),
      ...(properties ? { properties } : {}),
    },
  };
}

function accountError(accountId: unknown, userId: string): MethodResult | null {
  if (typeof accountId !== "string" || accountId !== publicAccountId(userId)) {
    return methodError("accountNotFound");
  }
  return null;
}

function positionLimit(
  args: Record<string, unknown>,
): { position: number; limit: number } | null {
  const position = args.position === undefined ? 0 : args.position;
  const limit = args.limit === undefined ? Number.MAX_SAFE_INTEGER : args.limit;
  if (
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 0
  ) {
    return null;
  }
  return { position, limit };
}

function validProperties(
  properties: unknown,
  supported: ReadonlySet<string>,
): boolean {
  return (
    properties === undefined ||
    properties === null ||
    (Array.isArray(properties) &&
      properties.every(
        (property) => typeof property === "string" && supported.has(property),
      ))
  );
}

const MAILBOX_PROPERTIES = new Set([
  "id",
  "name",
  "parentId",
  "role",
  "sortOrder",
  "totalEmails",
  "unreadEmails",
  "totalThreads",
  "unreadThreads",
  "myRights",
  "isSubscribed",
]);
const THREAD_PROPERTIES = new Set(["id", "emailIds"]);
const IDENTITY_PROPERTIES = new Set([
  "id",
  "name",
  "email",
  "replyTo",
  "bcc",
  "textSignature",
  "htmlSignature",
  "mayDelete",
]);

function filterProperties(
  object: Record<string, unknown>,
  properties: unknown,
): Record<string, unknown> | null {
  if (properties === undefined || properties === null) return object;
  if (
    !Array.isArray(properties) ||
    !properties.every((property) => typeof property === "string")
  ) {
    return null;
  }
  const result: Record<string, unknown> = { id: object.id };
  for (const property of properties as string[]) {
    if (property in object) result[property] = object[property];
  }
  return result;
}

/**
 * The Session object (RFC 8620 §2). `origin` is the scheme and host the client
 * reached: the URLs are absolute because clients use them as given (go-jmap,
 * and with it aerc, can't resolve a relative `apiUrl`).
 */
export async function makeSession(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  user: any,
  env: CloudflareBindings,
  origin: string,
): Promise<Record<string, unknown>> {
  const accountId = publicAccountId(user.id);
  // One limit for uploads and for an Email's attachments: whatever the
  // configured provider accepts as attachments (spec §2).
  const maxUpload = createEmailSender(env).maxAttachmentBytes();
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    capabilities: {
      [CORE_CAPABILITY]: {
        maxSizeUpload: maxUpload,
        maxConcurrentUpload: 4,
        maxSizeRequest: MAX_SIZE_REQUEST,
        maxConcurrentRequests: 4,
        maxCallsInRequest: MAX_CALLS_IN_REQUEST,
        maxObjectsInGet: MAX_OBJECTS_IN_GET,
        maxObjectsInSet: MAX_OBJECTS_IN_SET,
        collationAlgorithms: ["i;ascii-casemap"],
      },
      [MAIL_CAPABILITY]: {},
      [SUBMISSION_CAPABILITY]: {},
    },
    accounts: {
      [accountId]: {
        name: user.name || user.email || user.id,
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          [MAIL_CAPABILITY]: {
            maxMailboxesPerEmail: null,
            maxMailboxDepth: null,
            maxSizeMailboxName: 255,
            maxSizeAttachmentsPerEmail: maxUpload,
            emailQuerySortOptions: ["receivedAt"],
            mayCreateTopLevelMailbox: false,
          },
          [SUBMISSION_CAPABILITY]: {
            maxDelayedSend: MAX_DELAYED_SEND,
            // RFC 4865 §3: the EHLO keyword takes both arguments, the longest
            // hold in seconds and the latest release date-time (UTC).
            submissionExtensions: {
              FUTURERELEASE: [
                String(MAX_DELAYED_SEND),
                new Date((nowSeconds + MAX_DELAYED_SEND) * 1000)
                  .toISOString()
                  .replace(/\.\d{3}Z$/, "Z"),
              ],
            },
          },
        },
      },
    },
    // RFC 8620 keys primaryAccounts by capabilities present in
    // accountCapabilities. Core is session-level and is not listed there.
    primaryAccounts: {
      [MAIL_CAPABILITY]: accountId,
      [SUBMISSION_CAPABILITY]: accountId,
    },
    username: user.email ?? user.id,
    apiUrl: `${origin}/jmap/api`,
    downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${origin}/jmap/upload/{accountId}/`,
    eventSourceUrl: "",
    state: await sessionState(db, allowed, user, origin),
  };
}

async function mailboxGet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  args: Record<string, unknown>,
): Promise<MethodResult> {
  const account = accountError(args.accountId, userId);
  if (account) return account;
  if (!validProperties(args.properties, MAILBOX_PROPERTIES)) {
    return methodError("invalidArguments", undefined, ["properties"]);
  }
  const ids = args.ids;
  if (
    ids !== undefined &&
    ids !== null &&
    (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
  ) {
    return methodError("invalidArguments", undefined, ["ids"]);
  }
  if (Array.isArray(ids) && ids.length > MAX_OBJECTS_IN_GET) {
    return methodError("requestTooLarge");
  }

  const state = (await currentJmapState(db, allowed, userId)).state;
  const all = await listJmapMailboxes(db, allowed, userId);
  const byId = new Map(all.map((mailbox) => [mailbox.id as string, mailbox]));
  const requested =
    ids === undefined || ids === null
      ? all.map((mailbox) => mailbox.id as string)
      : (ids as string[]);
  if (requested.length > MAX_OBJECTS_IN_GET) {
    return methodError("requestTooLarge");
  }

  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of requested) {
    const mailbox = byId.get(id);
    if (!mailbox) {
      notFound.push(id);
      continue;
    }
    const selected = filterProperties(mailbox, args.properties);
    if (!selected) {
      return methodError("invalidArguments", undefined, ["properties"]);
    }
    list.push(selected);
  }

  return {
    ok: true,
    name: "Mailbox/get",
    result: {
      accountId: publicAccountId(userId),
      state,
      list,
      notFound,
    },
  };
}

async function mailboxQuery(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  args: Record<string, unknown>,
): Promise<MethodResult> {
  const account = accountError(args.accountId, userId);
  if (account) return account;
  if (args.filter !== undefined && args.filter !== null) {
    return methodError("invalidArguments", undefined, ["filter"]);
  }
  if (args.sort !== undefined && args.sort !== null) {
    return methodError("unsupportedSort");
  }
  const window = positionLimit(args);
  if (!window) {
    return methodError("invalidArguments", undefined, ["position", "limit"]);
  }

  const all = await listJmapMailboxes(db, allowed, userId);
  const ids = all.map((mailbox) => mailbox.id as string);
  const position =
    window.position < 0
      ? Math.max(0, ids.length + window.position)
      : window.position;
  return {
    ok: true,
    name: "Mailbox/query",
    result: {
      accountId: publicAccountId(userId),
      queryState: (await currentJmapState(db, allowed, userId)).state,
      canCalculateChanges: false,
      position,
      ids: ids.slice(position, position + window.limit),
      total: ids.length,
    },
  };
}

async function threadGet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  args: Record<string, unknown>,
): Promise<MethodResult> {
  const account = accountError(args.accountId, userId);
  if (account) return account;
  if (!validProperties(args.properties, THREAD_PROPERTIES)) {
    return methodError("invalidArguments", undefined, ["properties"]);
  }
  const ids = args.ids;
  if (
    ids !== undefined &&
    ids !== null &&
    (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
  ) {
    return methodError("invalidArguments", undefined, ["ids"]);
  }
  if (Array.isArray(ids) && ids.length > MAX_OBJECTS_IN_GET) {
    return methodError("requestTooLarge");
  }

  const state = (await currentJmapState(db, allowed, userId)).state;
  // Public id (as the client sent it, or as we emit it) -> internal thread key.
  const keyByPublic = new Map<string, string>();
  const requestedPublic: string[] = [];
  if (ids === undefined || ids === null) {
    const naturalKeys = await queryMessageThreadKeys(
      db,
      allowed,
      { viewer: { userId }, ignoreSnooze: true, withJmap: true },
      MAX_OBJECTS_IN_GET + 1,
    );
    const draftKeys = await listDraftThreadKeys(
      db,
      allowed,
      userId,
      MAX_OBJECTS_IN_GET + 1,
    );
    // JMAP-sent mail can thread under a key neither of those finds.
    const contentKeys = await listContentThreadKeys(
      db,
      allowed,
      MAX_OBJECTS_IN_GET + 1,
    );
    const combined = [
      ...new Set([...naturalKeys, ...draftKeys, ...contentKeys]),
    ];
    if (combined.length > MAX_OBJECTS_IN_GET) {
      return methodError("requestTooLarge");
    }
    for (const key of combined) {
      const publicId = publicThreadId(key);
      requestedPublic.push(publicId);
      keyByPublic.set(publicId, key);
    }
  } else {
    for (const publicId of ids as string[]) {
      requestedPublic.push(publicId);
      const key = parseThreadId(publicId);
      if (key !== null) keyByPublic.set(publicId, key);
    }
  }

  const queryKeys = [...new Set(keyByPublic.values())];
  const grouped = new Map<string, { id: string; at: number }[]>();
  // Public ids already filed under a key, so nothing is listed twice.
  const seen = new Set<string>();
  let emailCount = 0;

  for (
    let start = 0;
    start < queryKeys.length;
    start += THREAD_KEYS_PER_QUERY
  ) {
    const chunk = queryKeys.slice(start, start + THREAD_KEYS_PER_QUERY);
    const remaining = MAX_EMAILS_IN_THREAD_GET - emailCount;
    const page = await queryMessages(db, allowed, {
      threadKeys: chunk,
      limit: remaining + 1,
      order: "asc",
      viewer: { userId },
      withState: true,
      withJmap: true,
      ignoreSnooze: true,
    });

    emailCount += page.messages.length;
    if (page.hasMore || emailCount > MAX_EMAILS_IN_THREAD_GET) {
      return methodError(
        "requestTooLarge",
        `Thread/get is limited to ${MAX_EMAILS_IN_THREAD_GET} matching emails`,
      );
    }

    for (const message of page.messages) {
      const id = jmapMessageId(message);
      seen.add(id);
      const key = jmapThreadKey(message);
      const current = grouped.get(key) ?? [];
      current.push({ id, at: message.occurredAt });
      grouped.set(key, current);
    }
  }

  const draftMembers = await draftThreadMembers(db, allowed, userId, queryKeys);
  emailCount += draftMembers.length;
  if (emailCount > MAX_EMAILS_IN_THREAD_GET) {
    return methodError(
      "requestTooLarge",
      `Thread/get is limited to ${MAX_EMAILS_IN_THREAD_GET} matching emails`,
    );
  }
  for (const member of draftMembers) {
    const id = publicDraftEmailId(member.id);
    seen.add(id);
    const current = grouped.get(member.threadKey) ?? [];
    current.push({ id, at: member.receivedAt });
    grouped.set(member.threadKey, current);
  }

  // JMAP-sent mail keeps its content's thread key (RFC 8621: threadId is
  // immutable), which can differ from its natural conversation key, so look it
  // up by content key too.
  const extraRefs = (
    await loadContentKeyedSentRefs(db, allowed, queryKeys)
  ).filter((ref) => !seen.has(publicEmailId(ref)));
  for (
    let start = 0;
    start < extraRefs.length;
    start += MESSAGE_REFS_PER_QUERY
  ) {
    const page = await queryMessages(db, allowed, {
      messageRefs: extraRefs.slice(start, start + MESSAGE_REFS_PER_QUERY),
      limit: MESSAGE_REFS_PER_QUERY,
      order: "asc",
      viewer: { userId },
      withState: true,
      withJmap: true,
      ignoreSnooze: true,
    });
    emailCount += page.messages.length;
    if (emailCount > MAX_EMAILS_IN_THREAD_GET) {
      return methodError(
        "requestTooLarge",
        `Thread/get is limited to ${MAX_EMAILS_IN_THREAD_GET} matching emails`,
      );
    }
    for (const message of page.messages) {
      const id = jmapMessageId(message);
      if (seen.has(id)) continue;
      seen.add(id);
      const key = jmapThreadKey(message);
      const current = grouped.get(key) ?? [];
      current.push({ id, at: message.occurredAt });
      grouped.set(key, current);
    }
  }

  for (const members of grouped.values()) {
    members.sort(
      (left, right) => left.at - right.at || (left.id < right.id ? -1 : 1),
    );
  }

  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const publicId of [...new Set(requestedPublic)]) {
    const key = keyByPublic.get(publicId);
    const emailIds = key === undefined ? undefined : grouped.get(key);
    if (!emailIds) {
      notFound.push(publicId);
      continue;
    }
    const thread = filterProperties(
      { id: publicId, emailIds: emailIds.map((member) => member.id) },
      args.properties,
    );
    if (!thread) {
      return methodError("invalidArguments", undefined, ["properties"]);
    }
    list.push(thread);
  }

  return {
    ok: true,
    name: "Thread/get",
    result: {
      accountId: publicAccountId(userId),
      state,
      list,
      notFound,
    },
  };
}

/** The Identity objects the user sees; `Identity/get` and the Identity state. */
async function identityObjects(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
) {
  const rows = await listUsableIdentities(db, allowed);
  return rows.map((row) => ({
    id: publicIdentityId(row.email),
    name: row.displayName ?? row.email,
    email: row.email,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: row.signatureHtml ?? "",
    mayDelete: false,
  }));
}

async function identityGet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  args: Record<string, unknown>,
): Promise<MethodResult> {
  const account = accountError(args.accountId, userId);
  if (account) return account;
  if (!validProperties(args.properties, IDENTITY_PROPERTIES)) {
    return methodError("invalidArguments", undefined, ["properties"]);
  }
  const ids = args.ids;
  if (
    ids !== undefined &&
    ids !== null &&
    (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
  ) {
    return methodError("invalidArguments", undefined, ["ids"]);
  }
  if (Array.isArray(ids) && ids.length > MAX_OBJECTS_IN_GET) {
    return methodError("requestTooLarge");
  }

  const all = await identityObjects(db, allowed);
  const byId = new Map(all.map((identity) => [identity.id, identity]));
  const requested =
    ids === undefined || ids === null
      ? all.map((identity) => identity.id)
      : (ids as string[]);
  if (requested.length > MAX_OBJECTS_IN_GET) {
    return methodError("requestTooLarge");
  }

  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of requested) {
    const identity = byId.get(id);
    if (!identity) {
      notFound.push(id);
      continue;
    }
    const selected = filterProperties(identity, args.properties);
    if (!selected) {
      return methodError("invalidArguments", undefined, ["properties"]);
    }
    list.push(selected);
  }

  return {
    ok: true,
    name: "Identity/get",
    result: {
      accountId: publicAccountId(userId),
      state: await identityState(all),
      list,
      notFound,
    },
  };
}

/**
 * Identities are managed in saasmail settings, so `Identity/set` exists only so
 * a JMAP client gets a precise answer instead of `unknownMethod`.
 */
async function identitySet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  args: Record<string, unknown>,
): Promise<MethodResult> {
  const isObject = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (
    args.create !== undefined &&
    args.create !== null &&
    !isObject(args.create)
  ) {
    return methodError("invalidArguments", undefined, ["create"]);
  }
  if (
    args.update !== undefined &&
    args.update !== null &&
    !isObject(args.update)
  ) {
    return methodError("invalidArguments", undefined, ["update"]);
  }
  if (
    args.destroy !== undefined &&
    args.destroy !== null &&
    (!Array.isArray(args.destroy) ||
      !args.destroy.every((id) => typeof id === "string"))
  ) {
    return methodError("invalidArguments", undefined, ["destroy"]);
  }
  const state = await identityState(await identityObjects(db, allowed));
  if (
    args.ifInState !== undefined &&
    args.ifInState !== null &&
    args.ifInState !== state
  ) {
    return methodError("stateMismatch");
  }
  const known = new Set(
    (await listUsableIdentities(db, allowed)).map((row) =>
      publicIdentityId(row.email),
    ),
  );
  const readOnly = (id: string) =>
    known.has(id)
      ? {
          type: "forbidden",
          description: "Identities are managed in saasmail settings",
        }
      : { type: "notFound" };
  const notCreated: Record<string, unknown> = {};
  for (const id of Object.keys(
    (args.create ?? {}) as Record<string, unknown>,
  )) {
    notCreated[id] = {
      type: "forbidden",
      description: "Identities are managed in saasmail settings",
    };
  }
  const notUpdated: Record<string, unknown> = {};
  for (const id of Object.keys(
    (args.update ?? {}) as Record<string, unknown>,
  )) {
    notUpdated[id] = readOnly(id);
  }
  const notDestroyed: Record<string, unknown> = {};
  for (const id of (args.destroy ?? []) as string[])
    notDestroyed[id] = readOnly(id);
  const orNull = (value: Record<string, unknown>) =>
    Object.keys(value).length > 0 ? value : null;
  return {
    ok: true,
    name: "Identity/set",
    result: {
      accountId: publicAccountId(userId),
      oldState: state,
      newState: state,
      created: null,
      updated: null,
      destroyed: null,
      notCreated: orNull(notCreated),
      notUpdated: orNull(notUpdated),
      notDestroyed: orNull(notDestroyed),
    },
  };
}

export async function executeMethod(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  user: any,
  name: string,
  args: Record<string, unknown>,
  ctx: JmapMethodContext,
): Promise<MethodResult> {
  if (name === "Core/echo") {
    return { ok: true, name, result: args };
  }

  if (name === "Email/set") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    const result = await emailSet(
      db,
      allowed,
      user.id,
      publicAccountId(user.id),
      args,
      ctx,
    );
    const error = result as JmapMethodError;
    if (typeof error.type === "string") {
      return methodError(error.type, error.description, error.properties);
    }
    return { ok: true, name, result };
  }

  if (name === "EmailSubmission/set") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    const outcome = await emailSubmissionSet(db, allowed, user, args, ctx);
    if (isMethodError(outcome)) {
      const error = outcome as JmapMethodError;
      return methodError(error.type, error.description, error.properties);
    }
    return {
      ok: true,
      name,
      result: outcome.response,
      followUps: outcome.followUps,
    };
  }

  if (name === "Email/changes" || name === "Mailbox/changes") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    const result =
      name === "Email/changes"
        ? await emailChanges(
            db,
            allowed,
            user.id,
            publicAccountId(user.id),
            args,
          )
        : await mailboxChanges(
            db,
            allowed,
            user.id,
            publicAccountId(user.id),
            args,
          );
    const error = result as JmapMethodError;
    if (typeof error.type === "string") {
      return methodError(error.type, error.description, error.properties);
    }
    return { ok: true, name, result };
  }

  if (name === "EmailSubmission/get" || name === "EmailSubmission/query") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    const result =
      name === "EmailSubmission/get"
        ? await emailSubmissionGet(
            db,
            allowed,
            user.id,
            publicAccountId(user.id),
            args,
          )
        : await emailSubmissionQuery(
            db,
            allowed,
            user.id,
            publicAccountId(user.id),
            args,
          );
    const error = result as JmapMethodError;
    if (typeof error.type === "string") {
      return methodError(error.type, error.description, error.properties);
    }
    return { ok: true, name, result };
  }
  if (name === "EmailSubmission/changes") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    const result = await submissionChanges(
      db,
      allowed,
      user.id,
      publicAccountId(user.id),
      args,
    );
    const error = result as JmapMethodError;
    if (typeof error.type === "string") {
      return methodError(error.type, error.description, error.properties);
    }
    return { ok: true, name, result };
  }
  if (name === "EmailSubmission/queryChanges") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    return methodError("cannotCalculateChanges");
  }
  if (name === "Identity/set") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    return identitySet(db, allowed, user.id, args);
  }

  if (/\/(changes|queryChanges)$/.test(name)) {
    const type = name.split("/")[0];
    if (["Mailbox", "Email", "Thread", "Identity"].includes(type)) {
      const account = accountError(args.accountId, user.id);
      if (account) return account;
      return methodError("cannotCalculateChanges");
    }
  }

  if (name === "Mailbox/get") return mailboxGet(db, allowed, user.id, args);
  if (name === "Mailbox/query") return mailboxQuery(db, allowed, user.id, args);
  if (name === "Email/get") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    const result = await emailGet(
      db,
      allowed,
      user.id,
      publicAccountId(user.id),
      args,
    );
    const error = result as JmapMethodError;
    if (typeof error.type === "string") {
      return methodError(error.type, error.description, error.properties);
    }
    return { ok: true, name, result };
  }
  if (name === "Email/query") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    const result = await emailQuery(
      db,
      allowed,
      user.id,
      publicAccountId(user.id),
      args,
    );
    const error = result as JmapMethodError;
    if (typeof error.type === "string") {
      return methodError(error.type, error.description, error.properties);
    }
    return { ok: true, name, result };
  }
  if (name === "Thread/get") return threadGet(db, allowed, user.id, args);
  if (name === "Identity/get") return identityGet(db, allowed, user.id, args);

  return methodError("unknownMethod");
}
