import { asc, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { mailboxes } from "../db/mailboxes.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { isInboxAllowed, type AllowedInboxes } from "../lib/inbox-permissions";
import {
  buildMessageQuerySql,
  countMessages,
  type MessageFolder,
  type MessageQuery,
} from "../lib/messages/query";
import { SYSTEM_MAILBOX_ROLES, type SystemMailboxRole } from "./constants";
import { countDrafts, draftThreadKeySql, type DraftFilter } from "./drafts";
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

/** Strict mode is off, so narrow the descriptor union explicitly. */
export function isSystemDescriptor(
  descriptor: MailboxDescriptor,
): descriptor is Extract<MailboxDescriptor, { kind: "system" }> {
  return descriptor.kind === "system";
}

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
  if ("inboxes" in allowed) {
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

async function countThreadsAcross(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  messageQuery: MessageQuery | null,
  draftFilter: DraftFilter | null,
): Promise<number> {
  const arms: SQL[] = [];
  if (messageQuery) {
    const built = buildMessageQuerySql(allowed, {
      ...messageQuery,
      limit: null,
      cursor: undefined,
      offset: undefined,
      withState: true,
    });
    if (built) {
      arms.push(
        sql`SELECT COALESCE(conversation_key, kind || ':' || id) AS thread_key FROM (${built.statement})`,
      );
    }
  }
  if (draftFilter) arms.push(draftThreadKeySql(allowed, userId, draftFilter));
  if (arms.length === 0) return 0;
  const rows = await db.all<{ count: number }>(sql`
    SELECT COUNT(DISTINCT thread_key) AS count FROM (${sql.join(arms, sql` UNION ALL `)})
  `);
  return Number(rows[0]?.count ?? 0);
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
  const role = isSystemDescriptor(descriptor) ? descriptor.role : null;
  const drafts: DraftFilter | null =
    role === "drafts" || role === "trash"
      ? { inbox: descriptor.inbox, role }
      : descriptor.kind === "custom"
        ? { inbox: descriptor.inbox, mailboxId: descriptor.mailboxId }
        : null;
  let messages: MessageQuery | null = null;
  if (role !== "drafts") {
    const folder: MessageFolder = isSystemDescriptor(descriptor)
      ? folderForRole(descriptor.role)!
      : {
          mailboxId: (
            descriptor as Extract<MailboxDescriptor, { kind: "custom" }>
          ).mailboxId,
        };
    messages = {
      inboxes: [descriptor.inbox],
      folder,
      viewer: { userId },
      ignoreSnooze: true,
      // JMAP-only: keeps a pending submission's Sent row out of the counts
      // (spec §3.4). The web's own counts never pass this.
      withJmap: true,
    };
  }
  const unreadMessages = messages ? { ...messages, seen: false } : null;
  // RFC 8621 §2: unread means neither $seen nor $draft, so no draft is unread.
  const unreadDrafts: DraftFilter | null = null;
  const count = async (
    query: MessageQuery | null,
    filter: DraftFilter | null,
  ) =>
    (query ? await countMessages(db, allowed, query) : 0) +
    (filter ? await countDrafts(db, allowed, userId, filter) : 0);

  const [totalEmails, unreadEmails, totalThreads, unreadThreads] =
    await Promise.all([
      count(messages, drafts),
      count(unreadMessages, unreadDrafts),
      countThreadsAcross(db, allowed, userId, messages, drafts),
      countThreadsAcross(db, allowed, userId, unreadMessages, unreadDrafts),
    ]);
  return { totalEmails, unreadEmails, totalThreads, unreadThreads };
}

/** A Mailbox object and what it describes; counts are filled on request. */
export type JmapMailboxEntry = {
  descriptor: MailboxDescriptor;
  mailbox: Record<string, unknown>;
};

const MAILBOX_RIGHTS = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: false,
  mayRename: false,
  mayDelete: false,
  maySubmit: false,
};

/**
 * Every Mailbox the caller sees, in order, without counts: the four count
 * properties are null until `fillMailboxCounts` runs for the entry. Counting
 * costs four statements a mailbox, so only the mailboxes a response returns
 * pay for them.
 */
export async function listJmapMailboxes(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
): Promise<JmapMailboxEntry[]> {
  const descriptors = await loadMailboxDescriptors(db, allowed);
  const customRows = await db.select().from(mailboxes);
  const customById = new Map(customRows.map((row) => [row.id, row]));
  const list: JmapMailboxEntry[] = [];

  for (const descriptor of descriptors) {
    if (isSystemDescriptor(descriptor)) {
      list.push({
        descriptor,
        mailbox: {
          id: descriptor.id,
          name: `${ROLE_NAMES[descriptor.role]} — ${descriptor.inbox}`,
          parentId: null,
          role: descriptor.role,
          sortOrder: ROLE_SORT_ORDER[descriptor.role],
          totalEmails: null,
          unreadEmails: null,
          totalThreads: null,
          unreadThreads: null,
          myRights: { ...MAILBOX_RIGHTS },
          isSubscribed: true,
        },
      });
      continue;
    }

    const custom = descriptor as Extract<MailboxDescriptor, { kind: "custom" }>;
    const row = customById.get(custom.mailboxId);
    if (!row) continue;
    const parent = row.parentId ? customById.get(row.parentId) : undefined;
    list.push({
      descriptor,
      mailbox: {
        id: descriptor.id,
        name: row.name,
        parentId:
          parent && isInboxAllowed(allowed, parent.inbox)
            ? customMailboxId(parent.id)
            : null,
        role: null,
        sortOrder: 100 + row.sortOrder,
        totalEmails: null,
        unreadEmails: null,
        totalThreads: null,
        unreadThreads: null,
        myRights: { ...MAILBOX_RIGHTS },
        isSubscribed: true,
      },
    });
  }

  return list;
}

/** Sets the entry's four count properties (four statements). */
export async function fillMailboxCounts(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  entry: JmapMailboxEntry,
): Promise<void> {
  const counts = await mailboxCounts(db, allowed, userId, entry.descriptor);
  entry.mailbox.totalEmails = counts.totalEmails;
  entry.mailbox.unreadEmails = counts.unreadEmails;
  entry.mailbox.totalThreads = counts.totalThreads;
  entry.mailbox.unreadThreads = counts.unreadThreads;
}
