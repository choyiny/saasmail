import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { fetchStats } from "@/lib/api";
import { useLayoutSettings } from "@/lib/preferences";
import { DEFAULT_FAVORITES, type SwipeAction } from "./lib";

/**
 * State shared between the Outlook shell (suite header, settings flyout,
 * mobile drawer and tab bar) and the Outlook inbox (ribbon, folder pane,
 * list, reading pane). The shell provides it around every signed-in page.
 */

export type ReadingPanePos = "right" | "bottom" | "off";
export type QuickAction = "delete" | "archive" | "flag" | "pin" | "read";
export const ALL_QUICK_ACTIONS: QuickAction[] = [
  "delete",
  "archive",
  "flag",
  "pin",
  "read",
];
export type ListSortPref = "date" | "unread" | "files";

export interface LayoutPrefs {
  /** Focused Inbox (Focused / Other pivot). */
  focusedInbox: boolean;
  /** Hover actions shown on message list rows. */
  quickActions: QuickAction[];
  /** Folder keys pinned to Favorites (see lib.favoriteKey). */
  favorites: string[];
  favoritesOpen: boolean;
  accountOpen: boolean;
  inboxesOpen: boolean;
  /** Folder pane state below 1280px (collapsed by default, like Outlook). */
  folderPaneOpenNarrow: boolean;
  swipeRight: SwipeAction;
  swipeLeft: SwipeAction;
  readingPane: ReadingPanePos;
  conversationView: boolean;
  folderPaneOpen: boolean;
  listWidth: number;
  /** "Spacious" vs "Cozy" (both map to the comfortable account density). */
  spacious: boolean;
  /** Arrange by (server-side sort). */
  sort: ListSortPref;
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  focusedInbox: true,
  quickActions: ALL_QUICK_ACTIONS,
  favorites: DEFAULT_FAVORITES,
  favoritesOpen: true,
  accountOpen: true,
  inboxesOpen: true,
  folderPaneOpenNarrow: false,
  swipeRight: "archive",
  swipeLeft: "flag",
  readingPane: "right",
  conversationView: true,
  folderPaneOpen: true,
  listWidth: 380,
  spacious: false,
  sort: "date",
};

const SWIPES: SwipeAction[] = [
  "archive",
  "delete",
  "flag",
  "read",
  "snooze",
  "move",
  "none",
];

/** Settings come from the account; keep only well-formed values. */
export function sanitizeLayout(
  raw: Partial<Record<keyof LayoutPrefs, unknown>>,
): LayoutPrefs {
  const r = raw ?? {};
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    focusedInbox: bool(r.focusedInbox, true),
    quickActions: Array.isArray(r.quickActions)
      ? (r.quickActions as QuickAction[]).filter((a) =>
          ALL_QUICK_ACTIONS.includes(a),
        )
      : DEFAULT_LAYOUT.quickActions,
    favorites: Array.isArray(r.favorites)
      ? (r.favorites as unknown[]).filter(
          (f): f is string => typeof f === "string",
        )
      : DEFAULT_LAYOUT.favorites,
    favoritesOpen: bool(r.favoritesOpen, true),
    accountOpen: bool(r.accountOpen, true),
    inboxesOpen: bool(r.inboxesOpen, true),
    folderPaneOpenNarrow: bool(r.folderPaneOpenNarrow, false),
    swipeRight: SWIPES.includes(r.swipeRight as SwipeAction)
      ? (r.swipeRight as SwipeAction)
      : DEFAULT_LAYOUT.swipeRight,
    swipeLeft: SWIPES.includes(r.swipeLeft as SwipeAction)
      ? (r.swipeLeft as SwipeAction)
      : DEFAULT_LAYOUT.swipeLeft,
    readingPane: (["right", "bottom", "off"] as const).includes(
      r.readingPane as ReadingPanePos,
    )
      ? (r.readingPane as ReadingPanePos)
      : DEFAULT_LAYOUT.readingPane,
    conversationView: bool(r.conversationView, true),
    folderPaneOpen: bool(r.folderPaneOpen, true),
    listWidth:
      typeof r.listWidth === "number" &&
      r.listWidth >= 280 &&
      r.listWidth <= 720
        ? r.listWidth
        : DEFAULT_LAYOUT.listWidth,
    spacious: r.spacious === true,
    sort: (["date", "unread", "files"] as const).includes(
      r.sort as ListSortPref,
    )
      ? (r.sort as ListSortPref)
      : "date",
  };
}

export interface ComposeState {
  /** Bumps on every open so a fresh form mounts. */
  id: number;
  prefill: ComposePrefill | null;
  /** Reopened after Undo send / a failed send: attachments and the error. */
  files?: File[];
  error?: string;
}

interface OutlookContextValue extends LayoutPrefs {
  setLayout: (patch: Partial<LayoutPrefs>) => void;
  toggleFavorite: (key: string) => void;
  /** Folder pane open state for the current width (☰ toggles it). */
  setPaneOpen: (open: boolean) => void;
  /** Our inbox addresses (lower-case), for to: search mapping. */
  knownInboxes: string[];
  isMobile: boolean;
  compose: ComposeState | null;
  openCompose: (
    prefill?: ComposePrefill | null,
    extras?: { files?: File[]; error?: string },
  ) => void;
  closeCompose: () => void;
  /** The shared bottom-right tray, for flows the theme does not own. */
  openTrayCompose: (prefill?: ComposePrefill) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  mobileSearchOpen: boolean;
  setMobileSearchOpen: (open: boolean) => void;
  /** Mobile: the inbox hides the tab bar while a conversation is open. */
  hideTabBar: boolean;
  setHideTabBar: (hide: boolean) => void;
}

const OutlookContext = createContext<OutlookContextValue | null>(null);

export function OutlookProvider({
  children,
  onTrayCompose,
}: {
  children: ReactNode;
  onTrayCompose: (prefill?: ComposePrefill) => void;
}) {
  // Saved to the account (follows the user across devices).
  const [rawLayout, updateLayout] = useLayoutSettings(
    "outlook",
    DEFAULT_LAYOUT as unknown as Record<string, unknown>,
  );
  const layout = useMemo(
    () => sanitizeLayout(rawLayout as Partial<LayoutPrefs>),
    [rawLayout],
  );
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [hideTabBar, setHideTabBar] = useState(false);

  const setLayout = useCallback(
    (patch: Partial<LayoutPrefs>) =>
      updateLayout(patch as Partial<Record<string, unknown>>),
    [updateLayout],
  );
  const toggleFavorite = useCallback(
    (key: string) =>
      setLayout({
        favorites: layout.favorites.includes(key)
          ? layout.favorites.filter((f) => f !== key)
          : [...layout.favorites, key],
      }),
    [layout.favorites, setLayout],
  );
  const [knownInboxes, setKnownInboxes] = useState<string[]>([]);
  useEffect(() => {
    fetchStats()
      .then((s) => setKnownInboxes(s.recipients.map((r) => r.toLowerCase())))
      .catch(() => {});
  }, []);
  const isMobile = useIsMobile();
  const narrow = useMedia("(max-width: 1279px)");
  const setPaneOpen = useCallback(
    (open: boolean) =>
      setLayout(
        narrow ? { folderPaneOpenNarrow: open } : { folderPaneOpen: open },
      ),
    [narrow, setLayout],
  );

  const openCompose = useCallback(
    (
      prefill?: ComposePrefill | null,
      extras?: { files?: File[]; error?: string },
    ) => {
      setCompose((prev) => ({
        id: (prev?.id ?? 0) + 1,
        prefill: prefill ?? null,
        ...extras,
      }));
    },
    [],
  );
  const closeCompose = useCallback(() => setCompose(null), []);

  const value = useMemo<OutlookContextValue>(
    () => ({
      ...layout,
      folderPaneOpen: narrow
        ? layout.folderPaneOpenNarrow
        : layout.folderPaneOpen,
      setPaneOpen,
      setLayout,
      toggleFavorite,
      knownInboxes,
      isMobile,
      compose,
      openCompose,
      closeCompose,
      openTrayCompose: onTrayCompose,
      settingsOpen,
      setSettingsOpen,
      shortcutsOpen,
      setShortcutsOpen,
      drawerOpen,
      setDrawerOpen,
      mobileSearchOpen,
      setMobileSearchOpen,
      hideTabBar,
      setHideTabBar,
    }),
    [
      layout,
      narrow,
      setPaneOpen,
      setLayout,
      toggleFavorite,
      knownInboxes,
      isMobile,
      compose,
      openCompose,
      closeCompose,
      onTrayCompose,
      settingsOpen,
      shortcutsOpen,
      drawerOpen,
      mobileSearchOpen,
      hideTabBar,
    ],
  );

  return (
    <OutlookContext.Provider value={value}>{children}</OutlookContext.Provider>
  );
}

export function useOutlook(): OutlookContextValue {
  const ctx = useContext(OutlookContext);
  if (!ctx) throw new Error("useOutlook must be used inside OutlookShell");
  return ctx;
}

/** Media query hook. */
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export const useIsMobile = () => useMedia("(max-width: 767px)");
