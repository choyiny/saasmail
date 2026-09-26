import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import {
  InvalidMessageStateError,
  MessageStateAccessError,
  setMailboxMembership,
  setMailboxState,
  setUserState,
} from "../lib/messages/state";
import type { UnifiedMessage } from "../lib/messages/types";
import { MAX_OBJECTS_IN_SET } from "./constants";
import {
  jmapKeywords,
  jmapMailboxIds,
  loadJmapEmailObjectsByIds,
  type JmapMethodError,
} from "./emails";
import { loadMailboxDescriptors, type MailboxDescriptor } from "./mailboxes";
import { currentJmapState, parseJmapState } from "./state";

type SetError = {
  type: string;
  properties?: string[];
};

type PatchResult =
  | {
      keywords: Set<string>;
      mailboxIds: Set<string>;
    }
  | SetError;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyOrNull<T extends Record<string, unknown>>(value: T): T | null {
  return Object.keys(value).length === 0 ? null : value;
}

function decodePointerSegment(value: string): string | null {
  if (/~(?:[^01]|$)/.test(value)) return null;
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function validateSetArguments(args: Record<string, unknown>):
  | {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      destroy: string[];
    }
  | JmapMethodError {
  const createValue = args.create;
  const updateValue = args.update;
  const destroyValue = args.destroy;

  if (
    createValue !== undefined &&
    createValue !== null &&
    !isObject(createValue)
  ) {
    return { type: "invalidArguments", properties: ["create"] };
  }
  if (
    updateValue !== undefined &&
    updateValue !== null &&
    !isObject(updateValue)
  ) {
    return { type: "invalidArguments", properties: ["update"] };
  }
  if (
    destroyValue !== undefined &&
    destroyValue !== null &&
    (!Array.isArray(destroyValue) ||
      !destroyValue.every((id) => typeof id === "string"))
  ) {
    return { type: "invalidArguments", properties: ["destroy"] };
  }

  return {
    create: (createValue ?? {}) as Record<string, unknown>,
    update: (updateValue ?? {}) as Record<string, unknown>,
    destroy: (destroyValue ?? []) as string[],
  };
}

function fullSet(
  value: unknown,
  property: "keywords" | "mailboxIds",
): Set<string> | SetError {
  if (!isObject(value)) {
    return { type: "invalidProperties", properties: [property] };
  }
  if (Object.values(value).some((item) => item !== true)) {
    return { type: "invalidProperties", properties: [property] };
  }
  return new Set(Object.keys(value));
}

function patchTargets(
  message: UnifiedMessage,
  patchValue: unknown,
): PatchResult {
  if (!isObject(patchValue)) return { type: "invalidPatch" };
  const patch = patchValue as Record<string, unknown>;
  const keys = Object.keys(patch);

  for (const root of ["keywords", "mailboxIds"] as const) {
    if (
      Object.prototype.hasOwnProperty.call(patch, root) &&
      keys.some((key) => key.startsWith(`${root}/`))
    ) {
      return { type: "invalidPatch" };
    }
  }

  const currentKeywords = new Set(Object.keys(jmapKeywords(message)));
  const currentMailboxIds = new Set(Object.keys(jmapMailboxIds(message)));
  let targetKeywords = new Set(currentKeywords);
  let targetMailboxIds = new Set(currentMailboxIds);

  for (const [path, value] of Object.entries(patch)) {
    if (path === "keywords") {
      const result = fullSet(value, "keywords");
      if (result instanceof Set) targetKeywords = result;
      else return result;
      continue;
    }
    if (path === "mailboxIds") {
      const result = fullSet(value, "mailboxIds");
      if (result instanceof Set) targetMailboxIds = result;
      else return result;
      continue;
    }

    const slash = path.indexOf("/");
    if (slash <= 0) return { type: "invalidPatch" };
    const root = path.slice(0, slash);
    if (root !== "keywords" && root !== "mailboxIds") {
      return { type: "invalidPatch" };
    }
    const segment = decodePointerSegment(path.slice(slash + 1));
    if (segment === null || segment.length === 0) {
      return { type: "invalidPatch" };
    }
    if (value !== true && value !== null) return { type: "invalidPatch" };

    const target = root === "keywords" ? targetKeywords : targetMailboxIds;
    if (value === true) target.add(segment);
    else target.delete(segment);
  }

  if (
    [...targetKeywords].some(
      (keyword) => keyword !== "$seen" && keyword !== "$flagged",
    )
  ) {
    return { type: "invalidProperties", properties: ["keywords"] };
  }

  return { keywords: targetKeywords, mailboxIds: targetMailboxIds };
}

function validateMailboxTarget(
  message: UnifiedMessage,
  targetIds: Set<string>,
  descriptorsById: Map<string, MailboxDescriptor>,
):
  | {
      system: Extract<MailboxDescriptor, { kind: "system" }>;
      folders: Set<string>;
    }
  | SetError {
  if (targetIds.size === 0) {
    return { type: "invalidProperties", properties: ["mailboxIds"] };
  }

  const inbox = message.inbox.toLowerCase();
  const descriptors: MailboxDescriptor[] = [];
  for (const id of targetIds) {
    const descriptor = descriptorsById.get(id);
    if (!descriptor || descriptor.inbox.toLowerCase() !== inbox) {
      return { type: "invalidProperties", properties: ["mailboxIds"] };
    }
    descriptors.push(descriptor);
  }

  const systems = descriptors.filter(
    (item): item is Extract<MailboxDescriptor, { kind: "system" }> =>
      item.kind === "system",
  );
  if (systems.length !== 1 || systems[0].role === "drafts") {
    return { type: "invalidProperties", properties: ["mailboxIds"] };
  }

  const allowedRoles =
    message.ref.kind === "received"
      ? new Set(["inbox", "archive", "junk", "trash"])
      : new Set(["sent", "trash"]);
  if (!allowedRoles.has(systems[0].role)) {
    return { type: "invalidProperties", properties: ["mailboxIds"] };
  }

  return {
    system: systems[0],
    folders: new Set(
      descriptors
        .filter(
          (item): item is Extract<MailboxDescriptor, { kind: "custom" }> =>
            item.kind === "custom",
        )
        .map((item) => item.mailboxId),
    ),
  };
}

function mailboxStateForRole(
  message: UnifiedMessage,
  role: string,
): { archived?: boolean; spam?: boolean; trashed?: boolean } | SetError {
  if (message.ref.kind === "sent") {
    if (role === "sent") return { trashed: false };
    if (role === "trash") return { trashed: true };
    return { type: "invalidProperties", properties: ["mailboxIds"] };
  }

  if (role === "inbox") {
    return { archived: false, spam: false, trashed: false };
  }
  if (role === "archive") {
    return { archived: true, spam: false, trashed: false };
  }
  if (role === "junk") {
    return { archived: false, spam: true, trashed: false };
  }
  if (role === "trash") return { trashed: true };
  return { type: "invalidProperties", properties: ["mailboxIds"] };
}

function setDifference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value));
}

function setErrorForService(error: unknown): SetError | null {
  if (error instanceof MessageStateAccessError) return { type: "notFound" };
  if (error instanceof InvalidMessageStateError) {
    return { type: "invalidProperties" };
  }
  return null;
}

export async function emailSet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  const parsed = validateSetArguments(args);
  if ("type" in parsed) return parsed;
  const { create, update, destroy } = parsed;

  if (Object.keys(update).length > MAX_OBJECTS_IN_SET) {
    return {
      type: "requestTooLarge",
      description: `update exceeds maxObjectsInSet (${MAX_OBJECTS_IN_SET})`,
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

  const notCreated: Record<string, SetError> = {};
  for (const id of Object.keys(create)) {
    notCreated[id] = { type: "forbidden" };
  }
  const notDestroyed: Record<string, SetError> = {};
  for (const id of destroy) {
    notDestroyed[id] = { type: "forbidden" };
  }

  const updateIds = Object.keys(update);
  const loaded = await loadJmapEmailObjectsByIds(
    db,
    allowed,
    userId,
    updateIds,
  );
  const descriptors = await loadMailboxDescriptors(db, allowed);
  const descriptorsById = new Map(
    descriptors.map((descriptor) => [descriptor.id, descriptor]),
  );

  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};

  for (const id of updateIds) {
    const message = loaded.get(id);
    if (!message) {
      notUpdated[id] = { type: "notFound" };
      continue;
    }

    const targets = patchTargets(message, update[id]);
    if ("type" in targets) {
      notUpdated[id] = targets;
      continue;
    }

    const mailboxTarget = validateMailboxTarget(
      message,
      targets.mailboxIds,
      descriptorsById,
    );
    if ("type" in mailboxTarget) {
      notUpdated[id] = mailboxTarget;
      continue;
    }

    const currentKeywords = new Set(Object.keys(jmapKeywords(message)));
    const targetSeen = targets.keywords.has("$seen");
    const targetStarred = targets.keywords.has("$flagged");
    const currentSeen = currentKeywords.has("$seen");
    const currentStarred = currentKeywords.has("$flagged");
    if (message.ref.kind === "sent" && !targetSeen) {
      notUpdated[id] = {
        type: "invalidProperties",
        properties: ["keywords"],
      };
      continue;
    }

    const currentMailboxIds = new Set(Object.keys(jmapMailboxIds(message)));
    const currentSystemId = [...currentMailboxIds].find(
      (mailboxId) => descriptorsById.get(mailboxId)?.kind === "system",
    );
    const systemChanged = currentSystemId !== mailboxTarget.system.id;
    const systemState = mailboxStateForRole(message, mailboxTarget.system.role);
    if ("type" in systemState) {
      notUpdated[id] = systemState;
      continue;
    }

    const currentFolders = new Set(message.state?.mailboxIds ?? []);
    const add = setDifference(mailboxTarget.folders, currentFolders);
    const remove = setDifference(currentFolders, mailboxTarget.folders);
    const keywordChanges: { seen?: boolean; starred?: boolean } = {};
    if (targetSeen !== currentSeen) keywordChanges.seen = targetSeen;
    if (targetStarred !== currentStarred)
      keywordChanges.starred = targetStarred;

    try {
      if (systemChanged) {
        await setMailboxState(db, allowed, userId, [message.ref], systemState);
      }
      if (add.length > 0 || remove.length > 0) {
        await setMailboxMembership(db, allowed, userId, [message.ref], {
          add,
          remove,
        });
      }
      if (
        keywordChanges.seen !== undefined ||
        keywordChanges.starred !== undefined
      ) {
        await setUserState(db, userId, [message.ref], keywordChanges);
      }
      updated[id] = null;
    } catch (error) {
      const setError = setErrorForService(error);
      if (!setError) throw error;
      notUpdated[id] = setError;
    }
  }

  const newState = (await currentJmapState(db, allowed, userId)).state;
  return {
    accountId,
    oldState,
    newState,
    created: null,
    updated: nonEmptyOrNull(updated),
    destroyed: null,
    notCreated: nonEmptyOrNull(notCreated),
    notUpdated: nonEmptyOrNull(notUpdated),
    notDestroyed: nonEmptyOrNull(notDestroyed),
  };
}
