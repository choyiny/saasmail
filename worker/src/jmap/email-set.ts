import type { DrizzleD1Database } from "drizzle-orm/d1";
import { createEmailSender } from "../lib/email-sender";
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
import type { CreatedIds } from "./creation-refs";
import { resolveCreationRef } from "./creation-refs";
import {
  destroyDraft,
  draftKeywords,
  draftMailboxIds,
  loadDraftsByIds,
  updateDraftState,
  type DraftWithContent,
} from "./drafts";
import {
  DRAFT_KEYWORDS,
  createDraftEmail,
  Rejection,
  type SetError,
} from "./email-create";
import {
  jmapKeywords,
  jmapMailboxIds,
  loadJmapEmailObjectsByIds,
  type JmapMethodError,
} from "./emails";
import {
  isSystemDescriptor,
  loadMailboxDescriptors,
  type MailboxDescriptor,
} from "./mailboxes";
import type { JmapMethodContext } from "./methods";
import { parseAnyEmailId, publicDraftEmailId } from "./public-ids";
import { currentJmapState, parseJmapState } from "./state";

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

const MESSAGE_KEYWORDS: ReadonlySet<string> = new Set(["$seen", "$flagged"]);

function patchTargets(
  current: { keywords: Set<string>; mailboxIds: Set<string> },
  patchValue: unknown,
  allowedKeywords: ReadonlySet<string>,
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

  let targetKeywords = new Set(current.keywords);
  let targetMailboxIds = new Set(current.mailboxIds);

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

  if ([...targetKeywords].some((keyword) => !allowedKeywords.has(keyword))) {
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

async function updateMessage(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  message: UnifiedMessage,
  patch: unknown,
  descriptorsById: Map<string, MailboxDescriptor>,
): Promise<SetError | null> {
  const targets = patchTargets(
    {
      keywords: new Set(Object.keys(jmapKeywords(message))),
      mailboxIds: new Set(Object.keys(jmapMailboxIds(message))),
    },
    patch,
    MESSAGE_KEYWORDS,
  );
  if ("type" in targets) return targets;

  const mailboxTarget = validateMailboxTarget(
    message,
    targets.mailboxIds,
    descriptorsById,
  );
  if ("type" in mailboxTarget) return mailboxTarget;

  const currentKeywords = new Set(Object.keys(jmapKeywords(message)));
  const targetSeen = targets.keywords.has("$seen");
  const targetStarred = targets.keywords.has("$flagged");
  const currentSeen = currentKeywords.has("$seen");
  const currentStarred = currentKeywords.has("$flagged");
  if (message.ref.kind === "sent" && !targetSeen) {
    return { type: "invalidProperties", properties: ["keywords"] };
  }

  const currentMailboxIds = new Set(Object.keys(jmapMailboxIds(message)));
  const currentSystemId = [...currentMailboxIds].find(
    (mailboxId) => descriptorsById.get(mailboxId)?.kind === "system",
  );
  const systemChanged = currentSystemId !== mailboxTarget.system.id;
  const systemState = mailboxStateForRole(message, mailboxTarget.system.role);
  if ("type" in systemState) return systemState;

  const currentFolders = new Set(message.state?.mailboxIds ?? []);
  const add = setDifference(mailboxTarget.folders, currentFolders);
  const remove = setDifference(currentFolders, mailboxTarget.folders);
  const keywordChanges: { seen?: boolean; starred?: boolean } = {};
  if (targetSeen !== currentSeen) keywordChanges.seen = targetSeen;
  if (targetStarred !== currentStarred) keywordChanges.starred = targetStarred;

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
    return null;
  } catch (error) {
    const setError = setErrorForService(error);
    if (!setError) throw error;
    return setError;
  }
}

/**
 * Spec §3.3, draft row: a draft lives in exactly one system mailbox of its own
 * inbox (role `drafts` or `trash`) and always keeps `$draft`.
 */
async function updateDraft(
  db: DrizzleD1Database<any>,
  item: DraftWithContent,
  patch: unknown,
  descriptorsById: Map<string, MailboxDescriptor>,
  now: number,
): Promise<SetError | null> {
  const { draft } = item;
  const targets = patchTargets(
    {
      keywords: new Set(Object.keys(draftKeywords(draft))),
      mailboxIds: new Set(Object.keys(draftMailboxIds(draft))),
    },
    patch,
    DRAFT_KEYWORDS,
  );
  if ("type" in targets) return targets;
  if (!targets.keywords.has("$draft")) {
    return { type: "invalidProperties", properties: ["keywords"] };
  }
  const [targetId] = [...targets.mailboxIds];
  const descriptor =
    targets.mailboxIds.size === 1 ? descriptorsById.get(targetId) : undefined;
  if (
    !descriptor ||
    !isSystemDescriptor(descriptor) ||
    descriptor.inbox !== draft.inbox
  ) {
    return { type: "invalidProperties", properties: ["mailboxIds"] };
  }
  const role = descriptor.role;
  if (role !== "drafts" && role !== "trash") {
    return { type: "invalidProperties", properties: ["mailboxIds"] };
  }
  await updateDraftState(
    db,
    draft,
    {
      mailboxRole: role,
      seen: targets.keywords.has("$seen"),
      flagged: targets.keywords.has("$flagged"),
    },
    now,
  );
  return null;
}

export async function emailSet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
  ctx: JmapMethodContext,
): Promise<Record<string, unknown> | JmapMethodError> {
  const parsed = validateSetArguments(args);
  if ("type" in parsed) return parsed;
  const { create, update, destroy } = parsed;

  if (Object.keys(create).length > MAX_OBJECTS_IN_SET) {
    return {
      type: "requestTooLarge",
      description: `create exceeds maxObjectsInSet (${MAX_OBJECTS_IN_SET})`,
    };
  }
  if (Object.keys(update).length > MAX_OBJECTS_IN_SET) {
    return {
      type: "requestTooLarge",
      description: `update exceeds maxObjectsInSet (${MAX_OBJECTS_IN_SET})`,
    };
  }
  if (destroy.length > MAX_OBJECTS_IN_SET) {
    return {
      type: "requestTooLarge",
      description: `destroy exceeds maxObjectsInSet (${MAX_OBJECTS_IN_SET})`,
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

  const now = Math.floor(Date.now() / 1000);
  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};
  // Creation ids usable later in this call (RFC 8620 §5.3), on top of earlier
  // calls' ones.
  const refs: CreatedIds = new Map(ctx.createdIds);
  if (Object.keys(create).length > 0) {
    const maxAttachmentBytes = createEmailSender(ctx.env).maxAttachmentBytes();
    for (const [creationId, value] of Object.entries(create)) {
      try {
        const result = await createDraftEmail(
          { db, env: ctx.env, allowed, userId, maxAttachmentBytes, now },
          value,
        );
        if (result instanceof Rejection) {
          notCreated[creationId] = result.error;
          continue;
        }
        created[creationId] = result;
        refs.set(creationId, result.id);
      } catch (error) {
        console.error(`[jmap] Email/set create ${creationId} failed:`, error);
        notCreated[creationId] = {
          type: "serverFail",
          description: "The draft could not be stored",
        };
      }
    }
  }

  const resolveId = (id: string) => resolveCreationRef(id, refs) ?? id;
  const updateEntries = Object.entries(update).map(
    ([id, patch]) => [resolveId(id), patch] as const,
  );
  const destroyIds = destroy.map(resolveId);

  const messageIds: string[] = [];
  const draftIds: string[] = [];
  for (const id of [...updateEntries.map(([id]) => id), ...destroyIds]) {
    const ref = parseAnyEmailId(id);
    if (ref && ref.kind === "draft") draftIds.push(ref.id);
    else messageIds.push(id);
  }
  const loadedMessages = await loadJmapEmailObjectsByIds(
    db,
    allowed,
    userId,
    messageIds,
  );
  const loadedDrafts = await loadDraftsByIds(db, allowed, userId, draftIds);
  const draftFor = (id: string): DraftWithContent | undefined => {
    const ref = parseAnyEmailId(id);
    if (!ref || ref.kind !== "draft") return undefined;
    const item = loadedDrafts.get(ref.id);
    // A non-canonical spelling of a draft id stays notFound.
    return item && publicDraftEmailId(item.draft.id) === id ? item : undefined;
  };

  const descriptors = await loadMailboxDescriptors(db, allowed);
  const descriptorsById = new Map(
    descriptors.map((descriptor) => [descriptor.id, descriptor]),
  );

  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  for (const [id, patch] of updateEntries) {
    const item = draftFor(id);
    const message = item ? undefined : loadedMessages.get(id);
    if (!item && !message) {
      notUpdated[id] = { type: "notFound" };
      continue;
    }
    const error = item
      ? await updateDraft(db, item, patch, descriptorsById, now)
      : await updateMessage(
          db,
          allowed,
          userId,
          message!,
          patch,
          descriptorsById,
        );
    if (error) notUpdated[id] = error;
    else updated[id] = null;
  }

  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};
  for (const id of destroyIds) {
    if (destroyed.includes(id)) continue;
    const item = draftFor(id);
    if (item) {
      await destroyDraft(db, ctx.env, item.draft);
      destroyed.push(id);
      continue;
    }
    const ref = parseAnyEmailId(id);
    // Master plan Decision 7: received and sent destroy stays forbidden.
    notDestroyed[id] =
      ref && ref.kind === "draft"
        ? { type: "notFound" }
        : { type: "forbidden" };
  }

  const newState = (await currentJmapState(db, allowed, userId)).state;
  return {
    accountId,
    oldState,
    newState,
    created: nonEmptyOrNull(created),
    updated: nonEmptyOrNull(updated),
    destroyed: destroyed.length > 0 ? destroyed : null,
    notCreated: nonEmptyOrNull(notCreated),
    notUpdated: nonEmptyOrNull(notUpdated),
    notDestroyed: nonEmptyOrNull(notDestroyed),
  };
}
