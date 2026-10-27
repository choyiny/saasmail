import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLayoutSettings } from "@/lib/preferences";
import { DEFAULT_UNDO_SEND_SECONDS } from "@/lib/undo-send";
import type { MailCategory, Stats } from "@/lib/api";

/* ── Gmail-only view settings (this device) ────────────────────────── */

export type ReadingPane = "none" | "right" | "below";
/** Gmail's three densities; the account setting only has two, so
 *  "default" vs "comfortable" lives on this device. */
export type GmailDensity = "default" | "comfortable" | "compact";
export type InboxType = "default" | "unread" | "starred";
export type SwipeAction = "archive" | "delete" | "read" | "snooze" | "none";

export interface ViewPrefs {
  readingPane: ReadingPane;
  density: Exclude<GmailDensity, "compact">;
  /** Primary / Promotions / Social / Updates tabs on the inbox. */
  tabs: boolean;
  inboxType: InboxType;
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
  /** Left nav collapsed to the icon rail (null = automatic by width). */
  railCollapsed: boolean | null;
  [key: string]: unknown;
}

export const DEFAULT_VIEW: ViewPrefs = {
  readingPane: "none",
  density: "default",
  tabs: true,
  inboxType: "default",
  swipeLeft: "archive",
  swipeRight: "archive",
  railCollapsed: null,
};

const SWIPES: SwipeAction[] = ["archive", "delete", "read", "snooze", "none"];

/** The server stores layout settings as-is; coerce anything unexpected to defaults. */
function sanitizeView(raw: Partial<ViewPrefs>): ViewPrefs {
  return {
    readingPane: ["right", "below"].includes(raw.readingPane as string)
      ? (raw.readingPane as ReadingPane)
      : "none",
    density: raw.density === "comfortable" ? "comfortable" : "default",
    tabs: raw.tabs !== false,
    inboxType: ["unread", "starred"].includes(raw.inboxType as string)
      ? (raw.inboxType as InboxType)
      : "default",
    swipeLeft: SWIPES.includes(raw.swipeLeft as SwipeAction)
      ? (raw.swipeLeft as SwipeAction)
      : "archive",
    swipeRight: SWIPES.includes(raw.swipeRight as SwipeAction)
      ? (raw.swipeRight as SwipeAction)
      : "archive",
    railCollapsed:
      typeof raw.railCollapsed === "boolean" ? raw.railCollapsed : null,
  };
}

/**
 * Gmail view settings, saved to the account (they follow the user across
 * devices).
 */
export function useGmailView() {
  const [raw, setRaw] = useLayoutSettings<ViewPrefs>("gmail", DEFAULT_VIEW);
  const view = useMemo(() => sanitizeView(raw), [raw]);
  const update = useCallback(
    (patch: Partial<ViewPrefs>) => setRaw(patch),
    [setRaw],
  );
  return { ...view, update };
}

const COMMON_DEFAULTS = { undoSendSeconds: DEFAULT_UNDO_SEND_SECONDS };

/** Settings shared by every layout (Undo Send delay). */
export function useCommonSettings() {
  return useLayoutSettings<{ undoSendSeconds: number }>(
    "common",
    COMMON_DEFAULTS,
  );
}

/* ── Recent searches ───────────────────────────────────────────────── */

const RECENT_KEY = "saasmail.gmail.recentSearches";

export function readRecentSearches(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function writeRecentSearches(list: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/* ── Media queries ─────────────────────────────────────────────────── */

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

export const MOBILE_QUERY = "(max-width: 767px)";
export const useIsMobile = () => useMediaQuery(MOBILE_QUERY);

export function useOnline(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/* ── Shell <-> inbox context ───────────────────────────────────────── */

/** Counts the nav shows (Gmail shows Inbox unread, Drafts total, etc.). */
export interface NavCounts {
  /** Unread conversations in the inbox (Primary when tabs are on). */
  inboxUnread: number;
  drafts: number;
  outbox: number;
  /** Unread conversations per inbox tab. */
  categories: Partial<Record<MailCategory, number>>;
  /** Unread conversations that arrived since the tab was last opened. */
  categoriesNew: Partial<Record<MailCategory, number>>;
}

export interface GmailShellApi {
  /** Open the navigation drawer (mobile). */
  openDrawer: () => void;
  /** Open the account sheet (mobile). */
  openAccount: () => void;
  /** Open the quick settings panel. */
  openQuickSettings: () => void;
  /** Focus the top search box (desktop) or the mobile search bar. */
  focusSearch: () => void;
  /** The inbox shares fresh stats so the nav counts stay in step. */
  reportStats: (s: Stats) => void;
  /** Re-fetch nav counts (after actions). */
  refreshCounts: () => void;
  /** Show the keyboard shortcut help. */
  openShortcuts: () => void;
  /** True while the inbox page is mounted (it draws its own mobile bar). */
  setInboxMounted: (v: boolean) => void;
  stats: Stats | null;
  counts: NavCounts;
}

export const EMPTY_COUNTS: NavCounts = {
  inboxUnread: 0,
  drafts: 0,
  outbox: 0,
  categories: {},
  categoriesNew: {},
};

export const GmailShellContext = createContext<GmailShellApi | null>(null);

const NOOP: GmailShellApi = {
  openDrawer: () => {},
  openAccount: () => {},
  openQuickSettings: () => {},
  focusSearch: () => {},
  reportStats: () => {},
  refreshCounts: () => {},
  openShortcuts: () => {},
  setInboxMounted: () => {},
  stats: null,
  counts: EMPTY_COUNTS,
};

export function useGmailShell(): GmailShellApi {
  return useContext(GmailShellContext) ?? NOOP;
}
