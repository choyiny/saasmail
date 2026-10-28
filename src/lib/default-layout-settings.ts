import { useLayoutSettings } from "@/lib/preferences";
import { type InboxSort, type InboxSortSpec } from "@/lib/api";

/**
 * View settings of the default layout, saved to the account
 * (`layoutSettings.default`) so they follow the user to every device.
 */
export interface DefaultLayoutSettings extends Record<string, unknown> {
  /** The portal rail is collapsed to icons. */
  railCollapsed: boolean;
  /** Width of the conversation list in List view, in px. */
  listWidth: number;
  /** Inbox sort key and direction. */
  inboxSort: InboxSortSpec;
}

export const DEFAULT_LIST_WIDTH = 384;
export const MIN_LIST_WIDTH = 56;
export const MAX_LIST_WIDTH = 640;

export const DEFAULT_LAYOUT_DEFAULTS: DefaultLayoutSettings = {
  railCollapsed: false,
  listWidth: DEFAULT_LIST_WIDTH,
  inboxSort: { key: "recency", direction: "desc" },
};

const SORT_KEYS: InboxSort[] = ["recency", "unread", "inbox", "attachments"];

/** Validate a saved `{key, direction}` sort. */
export function parseInboxSort(v: unknown): InboxSortSpec | null {
  if (
    v &&
    typeof v === "object" &&
    SORT_KEYS.includes((v as InboxSortSpec).key) &&
    ((v as InboxSortSpec).direction === "asc" ||
      (v as InboxSortSpec).direction === "desc")
  ) {
    return {
      key: (v as InboxSortSpec).key,
      direction: (v as InboxSortSpec).direction,
    };
  }
  return null;
}

export function clampListWidth(n: unknown): number {
  const w = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(w)) return DEFAULT_LIST_WIDTH;
  return Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, Math.round(w)));
}

/** The default layout's account-saved view settings. */
export function useDefaultLayoutSettings() {
  return useLayoutSettings<DefaultLayoutSettings>(
    "default",
    DEFAULT_LAYOUT_DEFAULTS,
  );
}

/**
 * Settings every layout shares (`layoutSettings.common`): the Undo Send
 * delay and whether chat bubbles hide signatures.
 */
export interface CommonSettings extends Record<string, unknown> {
  undoSendSeconds: number;
  hideSignatures: boolean;
}

export const COMMON_DEFAULTS: CommonSettings = {
  undoSendSeconds: 5,
  hideSignatures: false,
};

export function useCommonSettings() {
  return useLayoutSettings<CommonSettings>("common", COMMON_DEFAULTS);
}
