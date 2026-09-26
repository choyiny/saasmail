// Test-only shorthands over the production codec, so suites read like the
// old literal ids: rid("x") instead of "received:x".
import type { SystemMailboxRole } from "../jmap/constants";
import {
  JMAP_ID_PATTERN,
  publicAccountId,
  publicAttachmentBlobId,
  publicCustomMailboxId,
  publicEmailId,
  publicIdentityId,
  publicSystemMailboxId,
  publicThreadId,
} from "../jmap/public-ids";

export const acct = (userId: string) => publicAccountId(userId);
export const rid = (id: string) => publicEmailId({ kind: "received", id });
export const sid = (id: string) => publicEmailId({ kind: "sent", id });
export const sys = (inbox: string, role: SystemMailboxRole) =>
  publicSystemMailboxId(inbox, role);
export const mbx = (id: string) => publicCustomMailboxId(id);
export const thread = (internalKey: string) => publicThreadId(internalKey);
export const idn = (email: string) => publicIdentityId(email);
export const att = (attachmentId: string) =>
  publicAttachmentBlobId(attachmentId);

const ID_KEYS = new Set([
  "id",
  "accountId",
  "threadId",
  "blobId",
  "parentId",
  "emailIds",
  "ids",
  "notFound",
  "created",
  "updated",
  "destroyed",
]);

/** Every id-bearing value in a JMAP response body (keys, arrays, strings). */
export function collectJmapIds(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectJmapIds(item, into);
    return into;
  }
  if (!value || typeof value !== "object") return into;
  for (const [key, child] of Object.entries(value)) {
    if (key === "mailboxIds" && child && typeof child === "object") {
      into.push(...Object.keys(child));
    } else if (key === "accounts" && child && typeof child === "object") {
      into.push(...Object.keys(child));
    } else if (ID_KEYS.has(key)) {
      if (typeof child === "string") into.push(child);
      else if (Array.isArray(child)) {
        for (const item of child) if (typeof item === "string") into.push(item);
      } else if (child && typeof child === "object" && key !== "created") {
        into.push(...Object.keys(child));
      }
    }
    collectJmapIds(child, into);
  }
  return into;
}

export function expectAllJmapIdsValid(body: unknown): void {
  for (const id of collectJmapIds(body)) {
    if (!JMAP_ID_PATTERN.test(id)) {
      throw new Error(`invalid JMAP id in response: ${JSON.stringify(id)}`);
    }
  }
}
