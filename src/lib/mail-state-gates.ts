/**
 * Helpers that hide the grouped inbox's star, pin, archive, snooze and
 * trash controls while MAIL_STATE_ACTIONS_ENABLED is off. They live apart
 * from the flag so a test can turn the flag on by mocking that one module.
 */
import { MAIL_STATE_ACTIONS_ENABLED } from "@/lib/mail-state-actions";

/** Grouped-inbox folders that need the per-user mail state. */
export const MAIL_STATE_FOLDERS: readonly string[] = [
  "starred",
  "snoozed",
  "archive",
  "trash",
];

/** Whether a grouped-inbox folder or view id can be shown. */
export function mailStateFolderAvailable(id: string): boolean {
  return MAIL_STATE_ACTIONS_ENABLED || !MAIL_STATE_FOLDERS.includes(id);
}

/** The state handlers a row, thread header or selection bar offers. */
const STATE_HANDLERS = [
  "onToggleStar",
  "onTogglePin",
  "onArchive",
  "onSnooze",
  "onTrash",
  "onRestore",
  "onDelete",
] as const;

/**
 * Drops the star, pin, archive, snooze, trash, restore and delete-forever
 * handlers while the flag is off, so the controls built from them hide.
 */
export function gateMailActions<T extends object>(handlers: T): T {
  if (MAIL_STATE_ACTIONS_ENABLED) return handlers;
  const out = { ...handlers } as Record<string, unknown>;
  for (const k of STATE_HANDLERS) delete out[k];
  return out as T;
}

/** A state action, or undefined while the flag is off. */
export function ifMailState<T>(action: T): T | undefined {
  return MAIL_STATE_ACTIONS_ENABLED ? action : undefined;
}

/** Shortcuts that star, pin, archive, snooze, trash or open those views. */
const STATE_SHORTCUTS = ["e", "b", "s", "p", "#", "g s", "g b", "g a"];

/** Whether a listed keyboard shortcut works while the flag is off. */
export function mailStateShortcutAvailable(keys: string[]): boolean {
  return (
    MAIL_STATE_ACTIONS_ENABLED || !STATE_SHORTCUTS.includes(keys.join(" "))
  );
}
