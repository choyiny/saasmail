import { and, eq, ne } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { isInboxAllowed, type AllowedInboxes } from "../lib/inbox-permissions";
import { parseJmapDate } from "./dates";
import { MAX_OBJECTS_IN_GET } from "./constants";
import type { JmapMethodError } from "./emails";
import { parseSubmissionId, publicSubmissionId } from "./public-ids";
import { currentJmapState } from "./state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;
type SubmissionRow = typeof jmapSubmissions.$inferSelect;

const PROPERTIES = new Set([
  "id",
  "identityId",
  "emailId",
  "threadId",
  "envelope",
  "sendAt",
  "undoStatus",
  "deliveryStatus",
  "dsnBlobIds",
  "mdnBlobIds",
]);
const FILTER_KEYS = new Set([
  "identityIds",
  "emailIds",
  "threadIds",
  "undoStatus",
  "before",
  "after",
]);
const SORT_KEYS: Record<string, (row: SubmissionRow) => string | number> = {
  emailId: (row) => row.emailId,
  threadId: (row) => row.threadId,
  // RFC 8621 §7.3 names the property `sendAt` but sorts on `sentAt`; accept
  // both spellings.
  sentAt: (row) => row.sendAt,
  sendAt: (row) => row.sendAt,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

export function submissionObject(row: SubmissionRow): Record<string, unknown> {
  return {
    id: publicSubmissionId(row.id),
    identityId: row.identityId,
    emailId: row.emailId,
    threadId: row.threadId,
    envelope: JSON.parse(row.envelopeJson),
    sendAt: utcDate(row.sendAt),
    undoStatus: row.undoStatus,
    deliveryStatus: null,
    dsnBlobIds: [],
    mdnBlobIds: [],
  };
}

/**
 * The caller's visible submissions (every state but the `claimed` intention)
 * from inboxes they may still use.
 */
async function visibleSubmissions(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
): Promise<SubmissionRow[]> {
  const rows = await db
    .select()
    .from(jmapSubmissions)
    .where(
      and(
        eq(jmapSubmissions.userId, userId),
        ne(jmapSubmissions.attemptState, "claimed"),
      ),
    );
  return rows.filter((row) => isInboxAllowed(allowed, row.identityEmail));
}

export async function emailSubmissionGet(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  const properties = args.properties;
  if (
    properties !== undefined &&
    properties !== null &&
    (!Array.isArray(properties) ||
      !properties.every((p) => typeof p === "string" && PROPERTIES.has(p)))
  ) {
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
    return { type: "requestTooLarge" };
  }

  const state = (await currentJmapState(db, allowed, userId)).state;
  const rows = await visibleSubmissions(db, allowed, userId);
  const byId = new Map(rows.map((row) => [publicSubmissionId(row.id), row]));
  const requested =
    ids === undefined || ids === null ? [...byId.keys()] : (ids as string[]);
  if (requested.length > MAX_OBJECTS_IN_GET) return { type: "requestTooLarge" };

  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of [...new Set(requested)]) {
    const row = parseSubmissionId(id) === null ? undefined : byId.get(id);
    if (!row) {
      notFound.push(id);
      continue;
    }
    const full = submissionObject(row);
    if (properties === undefined || properties === null) {
      list.push(full);
      continue;
    }
    const selected: Record<string, unknown> = { id: full.id };
    for (const property of properties as string[])
      selected[property] = full[property];
    list.push(selected);
  }
  return { accountId, state, list, notFound };
}

export async function emailSubmissionQuery(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  const filter = args.filter ?? {};
  if (!isObject(filter)) {
    return { type: "invalidArguments", properties: ["filter"] };
  }
  if (
    "operator" in filter ||
    Object.keys(filter).some((key) => !FILTER_KEYS.has(key))
  ) {
    return { type: "unsupportedFilter" };
  }
  for (const key of ["identityIds", "emailIds", "threadIds"]) {
    const value = filter[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        !value.every((item) => typeof item === "string"))
    ) {
      return { type: "invalidArguments", properties: ["filter"] };
    }
  }
  if (
    filter.undoStatus !== undefined &&
    typeof filter.undoStatus !== "string"
  ) {
    return { type: "invalidArguments", properties: ["filter"] };
  }
  const bound = (value: unknown): number | null | undefined => {
    if (value === undefined) return undefined;
    const millis = parseJmapDate(value, { utc: true });
    return millis === null ? null : Math.floor(millis / 1000);
  };
  const before = bound(filter.before);
  const after = bound(filter.after);
  if (before === null || after === null) {
    return { type: "invalidArguments", properties: ["filter"] };
  }

  const comparators: {
    key: (row: SubmissionRow) => string | number;
    asc: boolean;
  }[] = [];
  if (args.sort !== undefined && args.sort !== null) {
    if (!Array.isArray(args.sort)) return { type: "unsupportedSort" };
    for (const comparator of args.sort) {
      if (
        !isObject(comparator) ||
        typeof comparator.property !== "string" ||
        !SORT_KEYS[comparator.property] ||
        (comparator.isAscending !== undefined &&
          typeof comparator.isAscending !== "boolean") ||
        (comparator.collation !== undefined && comparator.collation !== null)
      ) {
        return { type: "unsupportedSort" };
      }
      comparators.push({
        key: SORT_KEYS[comparator.property],
        asc: comparator.isAscending !== false,
      });
    }
  }
  if (comparators.length === 0) {
    comparators.push({ key: SORT_KEYS.sendAt, asc: true });
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
  if (
    args.calculateTotal !== undefined &&
    typeof args.calculateTotal !== "boolean"
  ) {
    return { type: "invalidArguments", properties: ["calculateTotal"] };
  }

  const inList = (value: unknown, candidate: string) =>
    value === undefined || (value as string[]).includes(candidate);
  const rows = (await visibleSubmissions(db, allowed, userId))
    .filter((row) => inList(filter.identityIds, row.identityId))
    .filter((row) => inList(filter.emailIds, row.emailId))
    .filter((row) => inList(filter.threadIds, row.threadId))
    .filter(
      (row) =>
        filter.undoStatus === undefined || row.undoStatus === filter.undoStatus,
    )
    .filter((row) => before === undefined || row.sendAt < before)
    .filter((row) => after === undefined || row.sendAt >= after)
    .sort((left, right) => {
      for (const { key, asc } of comparators) {
        const a = key(left);
        const b = key(right);
        if (a < b) return asc ? -1 : 1;
        if (a > b) return asc ? 1 : -1;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

  const start = position < 0 ? Math.max(0, rows.length + position) : position;
  const limit = Math.min(requestedLimit, MAX_OBJECTS_IN_GET);
  const result: Record<string, unknown> = {
    accountId,
    queryState: (await currentJmapState(db, allowed, userId)).state,
    canCalculateChanges: false,
    position: start,
    ids: rows
      .slice(start, start + limit)
      .map((row) => publicSubmissionId(row.id)),
  };
  if (args.calculateTotal === true) result.total = rows.length;
  return result;
}
