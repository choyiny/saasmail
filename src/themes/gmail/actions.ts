import type { GroupedItem, MailCategory } from "@/lib/api";

/** Row-level mail actions the list, rows, menus and conversation share. */
export interface RowActions {
  archive: (items: GroupedItem[]) => void;
  /** Back to the inbox: un-archive and/or un-snooze. */
  moveToInbox: (items: GroupedItem[]) => void;
  /**
   * Delete: moves to Trash (with Undo). Inside Trash it asks, then
   * deletes forever.
   */
  requestDelete: (items: GroupedItem[], after?: () => void) => void;
  /**
   * Admins only: deleting forever removes the person and all their mail
   * for the whole team (`DELETE /api/people/:id` is admin-gated). Menus
   * hide "Delete forever" / "Empty Trash" when this is false.
   */
  canDeleteForever: boolean;
  /** Out of Trash, back where it was. */
  restore: (items: GroupedItem[]) => void;
  /**
   * Always put mail from these senders in this inbox tab. Person rows only:
   * the server applies category overrides to person rows, so a group
   * conversation never moves.
   */
  moveToCategory: (items: GroupedItem[], category: MailCategory) => void;
  markRead: (items: GroupedItem[]) => void;
  markUnread: (items: GroupedItem[]) => Promise<void>;
  snooze: (items: GroupedItem[], until: number) => void;
  /** Opens the snooze picker for these rows. */
  pickSnooze: (items: GroupedItem[], after?: () => void) => void;
  star: (items: GroupedItem[], value?: boolean) => void;
  pin: (items: GroupedItem[], value?: boolean) => void;
  /** Open the conversation and start a reply / reply all / forward. */
  respond: (item: GroupedItem, how: "reply" | "replyAll" | "forward") => void;
  /** Search for everything from this row's sender. */
  findFrom: (item: GroupedItem) => void;
  /** Open the conversation in a new browser tab. */
  openInNewWindow: (item: GroupedItem) => void;
  /** Filter the list to a label (inbox address). */
  showLabel: (address: string) => void;
}

/** Imperative hooks the keyboard handler calls on the open conversation. */
export interface ConversationHandle {
  reply: () => void;
  replyAll: () => void;
  forward: () => void;
  expandAll: () => void;
  collapseAll: () => void;
  nextMessage: () => void;
  prevMessage: () => void;
}

export function inInboxView(item: GroupedItem) {
  return !item.archivedAt && !item.snoozedUntil && !item.trashedAt;
}

/** Sender addresses for a category override (person rows only). */
export function senderAddresses(items: GroupedItem[]): string[] {
  const out = new Set<string>();
  for (const it of items)
    if (it.type === "person") out.add(it.email.toLowerCase());
  return [...out];
}

/** Whether "Move to tab" can act on any of these rows. */
export function canMoveToTab(items: GroupedItem[]): boolean {
  return items.some((i) => i.type === "person");
}

export function senderEmail(item: GroupedItem): string {
  return item.type === "person"
    ? item.email
    : (item.participants[0]?.email ?? "");
}
