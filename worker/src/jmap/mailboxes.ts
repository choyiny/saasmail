import { asc } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { mailboxes } from "../db/mailboxes.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { isInboxAllowed, type AllowedInboxes } from "../lib/inbox-permissions";
import {
  countMessages,
  countMessageThreads,
  type MessageFolder,
} from "../lib/messages/query";
import { SYSTEM_MAILBOX_ROLES, type SystemMailboxRole } from "./constants";
import { customMailboxId, systemMailboxId } from "./ids";

export type MailboxDescriptor =
  | {
      kind: "system";
      id: string;
      inbox: string;
      role: SystemMailboxRole;
    }
  | {
      kind: "custom";
      id: string;
      inbox: string;
      mailboxId: string;
    };

export type IdentityRow = typeof senderIdentities.$inferSelect;

const ROLE_NAMES: Record<SystemMailboxRole, string> = {
  inbox: "Inbox",
  drafts: "Drafts",
  sent: "Sent",
  archive: "Archive",
  junk: "Junk",
  trash: "Trash",
};

const ROLE_SORT_ORDER: Record<SystemMailboxRole, number> = {
  inbox: 10,
  drafts: 20,
  sent: 30,
  archive: 40,
  junk: 50,
  trash: 60,
};

function folderForRole(role: SystemMailboxRole): MessageFolder | null {
  if (role === "drafts") return null;
  return role;
}

export async function listUsableIdentities(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
): Promise<IdentityRow[]> {
  const rows = await db
    .select()
    .from(senderIdentities)
    .orderBy(asc(senderIdentities.email));
  return rows.filter((row) => isInboxAllowed(allowed, row.email));
}

export async function listAllowedInboxAddresses(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
): Promise<string[]> {
  if (!allowed.isAdmin) {
    return [
      ...new Set(allowed.inboxes.map((email) => email.toLowerCase())),
    ].sort();
  }

  return (await listUsableIdentities(db, allowed))
    .map((row) => row.email.toLowerCase())
    .sort();
}

export async function loadMailboxDescriptors(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
): Promise<MailboxDescriptor[]> {
  const inboxes = await listAllowedInboxAddresses(db, allowed);
  const descriptors: MailboxDescriptor[] = [];

  for (const inbox of inboxes) {
    for (const role of SYSTEM_MAILBOX_ROLES) {
      descriptors.push({
        kind: "system",
        id: systemMailboxId(inbox, role),
        inbox,
        role,
      });
    }
  }

  const customRows = await db
    .select()
    .from(mailboxes)
    .orderBy(
      asc(mailboxes.inbox),
      asc(mailboxes.sortOrder),
      asc(mailboxes.name),
    );
  for (const row of customRows) {
    if (!isInboxAllowed(allowed, row.inbox)) continue;
    descriptors.push({
      kind: "custom",
      id: customMailboxId(row.id),
      inbox: row.inbox.toLowerCase(),
      mailboxId: row.id,
    });
  }

  return descriptors;
}

async function mailboxCounts(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  descriptor: MailboxDescriptor,
): Promise<{
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
}> {
  if (descriptor.kind === "system" && descriptor.role === "drafts") {
    return {
      totalEmails: 0,
      unreadEmails: 0,
      totalThreads: 0,
      unreadThreads: 0,
    };
  }

  const folder: MessageFolder =
    descriptor.kind === "custom"
      ? { mailboxId: descriptor.mailboxId }
      : folderForRole(descriptor.role)!;
  const base = {
    inboxes: [descriptor.inbox],
    folder,
    viewer: { userId },
    ignoreSnooze: true,
  };

  const [totalEmails, unreadEmails, totalThreads, unreadThreads] =
    await Promise.all([
      countMessages(db, allowed, base),
      countMessages(db, allowed, { ...base, seen: false }),
      countMessageThreads(db, allowed, base),
      countMessageThreads(db, allowed, { ...base, seen: false }),
    ]);

  return {
    totalEmails,
    unreadEmails,
    totalThreads,
    unreadThreads,
  };
}

export async function listJmapMailboxes(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const descriptors = await loadMailboxDescriptors(db, allowed);
  const customRows = await db.select().from(mailboxes);
  const customById = new Map(customRows.map((row) => [row.id, row]));
  const list: Record<string, unknown>[] = [];

  for (const descriptor of descriptors) {
    const counts = await mailboxCounts(db, allowed, userId, descriptor);
    if (descriptor.kind === "system") {
      list.push({
        id: descriptor.id,
        name: `${ROLE_NAMES[descriptor.role]} — ${descriptor.inbox}`,
        parentId: null,
        role: descriptor.role,
        sortOrder: ROLE_SORT_ORDER[descriptor.role],
        totalEmails: counts.totalEmails,
        unreadEmails: counts.unreadEmails,
        totalThreads: counts.totalThreads,
        unreadThreads: counts.unreadThreads,
        myRights: {
          mayReadItems: true,
          mayAddItems: descriptor.role !== "drafts",
          mayRemoveItems: descriptor.role !== "drafts",
          maySetSeen: descriptor.role !== "drafts",
          maySetKeywords: descriptor.role !== "drafts",
          mayCreateChild: false,
          mayRename: false,
          mayDelete: false,
          maySubmit: false,
        },
        isSubscribed: true,
      });
      continue;
    }

    const row = customById.get(descriptor.mailboxId);
    if (!row) continue;
    const parent = row.parentId ? customById.get(row.parentId) : undefined;
    list.push({
      id: descriptor.id,
      name: row.name,
      parentId:
        parent && isInboxAllowed(allowed, parent.inbox)
          ? customMailboxId(parent.id)
          : null,
      role: null,
      sortOrder: 100 + row.sortOrder,
      totalEmails: counts.totalEmails,
      unreadEmails: counts.unreadEmails,
      totalThreads: counts.totalThreads,
      unreadThreads: counts.unreadThreads,
      myRights: {
        mayReadItems: true,
        mayAddItems: true,
        mayRemoveItems: true,
        maySetSeen: true,
        maySetKeywords: true,
        mayCreateChild: false,
        mayRename: false,
        mayDelete: false,
        maySubmit: false,
      },
      isSubscribed: true,
    });
  }

  return list;
}
