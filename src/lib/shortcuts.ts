/**
 * Keyboard shortcuts for the default layout. SHORTCUT_GROUPS is what the
 * "?" sheet lists; the handlers live in PortalShell (app-wide keys and "g"
 * chords) and InboxPage (triage keys), so keep this list in step with them.
 */

export interface ShortcutDef {
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutDef[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Move around",
    items: [
      { keys: ["j"], label: "Next conversation" },
      { keys: ["k"], label: "Previous conversation" },
      { keys: ["Enter"], label: "Open conversation" },
      { keys: ["o"], label: "Open conversation" },
      { keys: ["Esc"], label: "Close conversation / clear selection" },
      { keys: ["u"], label: "Back to the list" },
      { keys: ["/"], label: "Search mail" },
      { keys: ["⌘", "K"], label: "Search people and run commands" },
    ],
  },
  {
    title: "Act on a conversation",
    items: [
      { keys: ["e"], label: "Archive (or move back to inbox)" },
      { keys: ["b"], label: "Snooze…" },
      { keys: ["s"], label: "Star / unstar" },
      { keys: ["p"], label: "Pin / unpin" },
      { keys: ["#"], label: "Move to Trash" },
      { keys: ["⇧", "I"], label: "Mark as read" },
      { keys: ["r"], label: "Reply" },
      { keys: ["x"], label: "Select" },
      { keys: ["z"], label: "Undo last action" },
    ],
  },
  {
    title: "Go to",
    items: [
      { keys: ["c"], label: "New message" },
      { keys: ["g", "i"], label: "Inbox" },
      { keys: ["g", "s"], label: "Starred" },
      { keys: ["g", "b"], label: "Snoozed" },
      { keys: ["g", "t"], label: "Sent" },
      { keys: ["g", "d"], label: "Drafts" },
      { keys: ["g", "a"], label: "Archive" },
      { keys: ["g", "q"], label: "Sequenced" },
      { keys: ["?"], label: "Show this list" },
    ],
  },
];

/**
 * The "g" go-to chord, shared by the shell (which owns it) and the inbox's
 * triage keys. While a chord is pending, the next key belongs to the
 * shell's navigation: the inbox ignores it whichever listener runs first.
 */
let goChordUntil = 0;
export const goChord = {
  start(): void {
    goChordUntil = Date.now() + 1200;
  },
  pending(): boolean {
    return Date.now() < goChordUntil;
  },
  end(): void {
    goChordUntil = 0;
  },
};

/**
 * True when a key event should be left alone by single-key shortcuts:
 * typing in a field or editor, a modifier is held, or a menu or dialog
 * has focus.
 */
export function shouldIgnoreKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  if (t.closest('[role="menu"],[role="dialog"],[role="listbox"]')) return true;
  return false;
}
