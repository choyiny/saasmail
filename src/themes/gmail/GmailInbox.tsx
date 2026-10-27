import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { RotateCw, WifiOff } from "lucide-react";
import {
  EMPTY_MAIL_ROW_STATE,
  fetchConversationEmails,
  fetchGroupedIds,
  fetchGroupedPeople,
  deletePerson,
  setCategoryOverride,
  fetchPerson,
  fetchPersonEmails,
  markEmailRead,
  type Email,
  type GroupedItem,
  type MailCategory,
  type MailItemRef,
} from "@/lib/api";
import { itemKey, itemTitle } from "@/hooks/useMailList";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { useSession } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";
import { usePreferences } from "@/lib/preferences";
import { showToast } from "@/lib/toast";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { cn } from "@/lib/utils";
import "./gmail.css";
import {
  buildListSearch,
  CATEGORY_LABELS,
  FOLDER_LABELS,
  folderQuery,
  isSearch,
  isTypingTarget,
  labelName,
  openParam,
  parseListState,
  parseOpen,
  rangeLabel,
  resolveShortcut,
  stateToQuery,
  withinRange,
  type ListState,
  type ShortcutPrefix,
} from "./lib";
import { useGmailShell, useGmailView, useIsMobile, useOnline } from "./state";
import {
  senderAddresses,
  senderEmail,
  type ConversationHandle,
  type RowActions,
} from "./actions";
import {
  CategoryTabs,
  ListToolbar,
  MailRow,
  SelectAllBanner,
  SkeletonRows,
  type SelectPreset,
} from "./DesktopList";
import {
  ComposeFab,
  MobileRows,
  MobileSearchBar,
  MobileSelectionBar,
  MobileSkeleton,
  PullIndicator,
} from "./MobileList";
import { CategoryRows, MobileSearchScreen } from "./MobileSearch";
import Conversation from "./Conversation";
import { EmptyState } from "./Empty";
import { ConfirmDialog, PickDateDialog } from "./ui";
import { labelsFrom } from "./Nav";
import { SearchChips } from "./Search";
import { RowMenu, type RowMenuState } from "./RowMenu";
import { PAGE_SIZE, useGmailList } from "./useGmailList";
import {
  DRAG_MIME,
  dragGhost,
  endRowDrag,
  onRowDrop,
  startRowDrag,
} from "./dnd";
import type { InlineMode } from "./InlineComposer";

type Patch = Partial<
  Pick<
    GroupedItem,
    | "starred"
    | "pinned"
    | "unreadCount"
    | "archivedAt"
    | "snoozedUntil"
    | "trashedAt"
  >
>;

function dedupe(list: GroupedItem[]): GroupedItem[] {
  const seen = new Set<string>();
  const out: GroupedItem[] = [];
  for (const it of list) {
    const k = itemKey(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

async function latestReceivedId(item: GroupedItem): Promise<string | null> {
  const emails: Email[] =
    item.type === "person"
      ? (await fetchPersonEmails(item.id, { limit: 50 })).emails
      : (await fetchConversationEmails(item.id)).emails;
  const received = emails
    .filter((e) => e.type === "received")
    .sort((a, b) => b.timestamp - a.timestamp);
  return received[0]?.id ?? null;
}

const ACTIONS: InlineMode[] = ["reply", "replyAll", "forward"];

export default function GmailInbox() {
  const { onCompose } = useOutletContext<{
    onCompose: (prefill?: ComposePrefill) => void;
  }>();
  const shell = useGmailShell();
  const {
    setInboxMounted,
    reportStats,
    focusSearch,
    openShortcuts,
    refreshCounts,
  } = shell;
  const isMobile = useIsMobile();
  const view = useGmailView();
  const prefs = usePreferences();
  const online = useOnline();
  const { data: session } = useSession();
  // Deleting forever is admin-only on the server (DELETE /api/people/:id).
  const isAdmin = session?.user?.role === "admin";
  const { brandName } = useBranding();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const routeParams = useParams<{ inbox?: string; personId?: string }>();

  const state = parseListState(params);
  const searching = isSearch(state);
  const tabsOn = view.tabs;
  // Dates in the query are relative to "now", so compute once per URL.
  const fq = useMemo(
    () => folderQuery(state, tabsOn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.toString(), tabsOn],
  );
  const showTabs =
    tabsOn && state.folder === "inbox" && !state.label && !searching;
  const activeTab: MailCategory = state.tab ?? "primary";
  const inboxType =
    state.folder === "inbox" && !searching ? view.inboxType : "default";

  const list = useGmailList({
    folder: fq.folder,
    recipient: state.label ?? undefined,
    q: state.q || undefined,
    unread: state.unread || undefined,
    drafts: fq.drafts,
    sequenced: fq.sequenced,
    hasAttachment: state.attachment || undefined,
    from: state.from || undefined,
    category: fq.category,
    after: fq.after,
    before: fq.before,
    subject: state.subject || undefined,
  });
  const queryKey = JSON.stringify([fq, state, inboxType]);

  const pane = isMobile ? "none" : view.readingPane;
  const density = prefs.density === "compact" ? "compact" : view.density;

  /* ── shell wiring ── */
  useEffect(() => {
    setInboxMounted(true);
    return () => setInboxMounted(false);
  }, [setInboxMounted]);
  useEffect(() => {
    if (list.stats) reportStats(list.stats);
  }, [list.stats, reportStats]);
  useEffect(() => {
    if (list.lastLoaded) refreshCounts();
  }, [list.lastLoaded, refreshCounts]);
  // Opening a tab marks it seen (its "N new" badge counts from here).
  const { setPreferences } = prefs;
  useEffect(() => {
    if (!showTabs || list.loading) return;
    const now = Math.floor(Date.now() / 1000);
    void setPreferences({ tabSeen: { [activeTab]: now } }).then(() =>
      refreshCounts(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTabs, activeTab, list.loading]);

  const stats = list.stats ?? shell.stats;
  const identities = stats?.senderIdentities ?? [];
  const labels = useMemo(() => labelsFrom(stats), [stats]);

  // Back online: reload.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) list.refresh();
    wasOnline.current = online;
  }, [online, list]);

  /* ── mobile infinite scroll: earlier pages kept here ── */
  const [earlier, setEarlier] = useState<GroupedItem[]>([]);
  useEffect(() => {
    setEarlier([]);
  }, [queryKey]);

  // "Unread first" / "Starred first": the top section is its own server
  // query (every unread / starred row in this view, newest first); the
  // rest of the list is the normal query without those rows.
  const [priority, setPriority] = useState<{
    items: GroupedItem[];
    total: number;
  } | null>(null);
  useEffect(() => {
    if (inboxType === "default") {
      setPriority(null);
      return;
    }
    let cancelled = false;
    fetchGroupedPeople({
      ...list.folderParams(),
      ...(inboxType === "unread" ? { unread: true } : { starred: true }),
      limit: 50,
    })
      .then((r) => !cancelled && setPriority({ items: r.data, total: r.total }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxType, queryKey, list.lastLoaded]);

  const isPriority = useCallback(
    (it: GroupedItem) =>
      inboxType === "unread"
        ? it.unreadCount > 0
        : inboxType === "starred"
          ? it.starred
          : false,
    [inboxType],
  );

  const displayed = useMemo(() => {
    const base = isMobile ? dedupe([...earlier, ...list.items]) : list.items;
    if (!priority) return base;
    const top = priority.items.filter(isPriority);
    const topKeys = new Set(top.map(itemKey));
    return [...top, ...base.filter((it) => !topKeys.has(itemKey(it)))];
  }, [isMobile, earlier, list.items, priority, isPriority]);

  /* ── open conversation (URL) ── */
  const openRef =
    parseOpen(params.get("open")) ??
    (routeParams.personId
      ? { type: "person" as const, id: routeParams.personId }
      : null);
  const openKey = openRef ? `${openRef.type}:${openRef.id}` : null;
  const doParam = params.get("do") as InlineMode | null;
  const initialAction = doParam && ACTIONS.includes(doParam) ? doParam : null;
  const fromList = openKey
    ? (displayed.find((it) => itemKey(it) === openKey) ??
      list.items.find((it) => itemKey(it) === openKey) ??
      null)
    : null;
  const [fallback, setFallback] = useState<GroupedItem | null>(null);
  useEffect(() => {
    if (!openRef || fromList) return;
    if (fallback && itemKey(fallback) === openKey) return;
    let cancelled = false;
    (async () => {
      try {
        if (openRef.type === "person") {
          const p = await fetchPerson(openRef.id);
          if (cancelled) return;
          setFallback({
            ...EMPTY_MAIL_ROW_STATE,
            type: "person",
            id: p.id,
            email: p.email,
            name: p.name,
            lastEmailAt: p.lastEmailAt,
            unreadCount: p.unreadCount,
            totalCount: p.totalCount,
            recipientCount: 1,
            recipients: p.recipient ? [p.recipient] : [],
            hasAttachment: 0,
            latestSubject: p.latestSubject ?? null,
          });
        } else {
          const c = await fetchConversationEmails(openRef.id);
          if (cancelled) return;
          const last = c.emails.reduce<Email | null>(
            (a, e) => (!a || e.timestamp > a.timestamp ? e : a),
            null,
          );
          setFallback({
            ...EMPTY_MAIL_ROW_STATE,
            type: "group",
            id: c.conversation.id,
            inbox: c.conversation.inbox,
            participants: c.conversation.participants,
            ccParticipants: [],
            lastEmailAt: last?.timestamp ?? 0,
            unreadCount: c.emails.filter(
              (e) => e.type === "received" && e.isRead === 0,
            ).length,
            totalCount: c.emails.length,
            hasAttachment: 0,
            latestSubject: last?.subject ?? null,
          });
        }
      } catch {
        if (!cancelled) {
          showToast({ kind: "error", message: "Conversation not found" });
          navigate(`/${buildListSearch(state)}`, { replace: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, !!fromList]);
  const openItem =
    fromList ?? (fallback && itemKey(fallback) === openKey ? fallback : null);

  const listUrl = useCallback(
    (extra?: { open?: string; do?: string }) => {
      const base = buildListSearch(state);
      if (!extra?.open) return `/${base}`;
      const p = new URLSearchParams(base);
      p.set("open", extra.open);
      if (extra.do) p.set("do", extra.do);
      return `/?${p.toString()}`;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.toString()],
  );

  /* ── selection & keyboard cursor ── */
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // "Select all N conversations": refs for every matching row (server).
  const [allRefs, setAllRefs] = useState<MailItemRef[] | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  // The row cursor only shows once the keyboard is used, like Gmail.
  const [kbdNav, setKbdNav] = useState(false);
  const anchorRef = useRef<number | null>(null);
  useEffect(() => {
    setSelectedKeys(new Set());
    setAllRefs(null);
    anchorRef.current = null;
  }, [queryKey, list.page]);
  const pageSelected = displayed.filter((it) => selectedKeys.has(itemKey(it)));
  const selected = pageSelected;
  const focusedIndex = Math.max(
    0,
    displayed.findIndex((it) => itemKey(it) === focusedKey),
  );
  const focused = displayed[focusedIndex] ?? null;

  const open = useCallback(
    (item: GroupedItem, opts?: { replace?: boolean; action?: InlineMode }) => {
      setFocusedKey(itemKey(item));
      navigate(listUrl({ open: openParam(item), do: opts?.action }), {
        replace: opts?.replace,
      });
    },
    [navigate, listUrl],
  );
  const back = useCallback(() => {
    navigate(listUrl());
  }, [navigate, listUrl]);

  // Returning to the list puts focus back on the row you came from.
  const lastOpen = useRef<string | null>(null);
  useEffect(() => {
    if (openKey) {
      lastOpen.current = openKey;
      return;
    }
    const k = lastOpen.current;
    if (!k || isMobile) return;
    lastOpen.current = null;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-key="${CSS.escape(k)}"]`,
      );
      if (el) {
        setFocusedKey(k);
        el.focus({ preventScroll: true });
        el.scrollIntoView({ block: "nearest" });
      }
    });
  }, [openKey, isMobile]);

  const toggleSelect = useCallback(
    (item: GroupedItem, range = false) => {
      setAllRefs(null);
      const idx = displayed.findIndex((it) => itemKey(it) === itemKey(item));
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        const k = itemKey(item);
        if (range && anchorRef.current !== null && idx >= 0) {
          const [a, b] = [anchorRef.current, idx].sort((x, y) => x - y);
          const on = !prev.has(k);
          for (let i = a; i <= b; i++) {
            const key = itemKey(displayed[i]);
            if (on) next.add(key);
            else next.delete(key);
          }
        } else if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      });
      anchorRef.current = idx;
    },
    [displayed],
  );

  const selectPreset = useCallback(
    (p: SelectPreset) => {
      setAllRefs(null);
      const pick = (f: (it: GroupedItem) => boolean) =>
        setSelectedKeys(new Set(displayed.filter(f).map(itemKey)));
      switch (p) {
        case "all":
          return pick(() => true);
        case "none":
          return setSelectedKeys(new Set());
        case "read":
          return pick((it) => it.unreadCount === 0);
        case "unread":
          return pick((it) => it.unreadCount > 0);
        case "starred":
          return pick((it) => it.starred);
        case "unstarred":
          return pick((it) => !it.starred);
      }
    },
    [displayed],
  );

  const clearSelection = () => {
    setSelectedKeys(new Set());
    setAllRefs(null);
  };

  /* ── dialogs & menus ── */
  const [confirm, setConfirm] = useState<{
    items: GroupedItem[];
    after?: () => void;
    /** Every row matching the view (Select all N / Empty Trash). */
    all?: boolean;
  } | null>(null);
  const [pick, setPick] = useState<{
    items: GroupedItem[];
    presets: boolean;
    after?: () => void;
    all?: boolean;
  } | null>(null);
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  /* ── actions ── */
  const patchLocal = (targets: GroupedItem[], patch: Patch | "remove") => {
    const keys = new Set(targets.map(itemKey));
    setPriority((p) =>
      p
        ? {
            ...p,
            items:
              patch === "remove"
                ? p.items.filter((it) => !keys.has(itemKey(it)))
                : p.items.map((it) =>
                    keys.has(itemKey(it))
                      ? ({ ...it, ...patch } as GroupedItem)
                      : it,
                  ),
          }
        : p,
    );
    setEarlier((prev) =>
      patch === "remove"
        ? prev.filter((it) => !keys.has(itemKey(it)))
        : prev.map((it) =>
            keys.has(itemKey(it)) ? ({ ...it, ...patch } as GroupedItem) : it,
          ),
    );
    setFallback((f) =>
      f && keys.has(itemKey(f)) && patch !== "remove"
        ? ({ ...f, ...patch } as GroupedItem)
        : f,
    );
    if (patch === "remove") {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        keys.forEach((k) => next.delete(k));
        return next;
      });
      setAllRefs(null);
    }
  };

  const leavesInbox = state.folder === "inbox";

  const leaveIfOpen = (targets: GroupedItem[]) => {
    if (!openKey || pane !== "none") return;
    if (targets.some((t) => itemKey(t) === openKey)) back();
  };

  const folderWhere = searching
    ? "this search"
    : state.label
      ? labelName(
          state.label,
          identities.find((s) => s.email === state.label)?.displayName,
        )
      : showTabs
        ? CATEGORY_LABELS[activeTab]
        : FOLDER_LABELS[state.folder];

  const doArchive = (its: GroupedItem[], verb?: string) => {
    void list.actions.archive(its, verb);
    patchLocal(
      its,
      leavesInbox ? "remove" : { archivedAt: Math.floor(Date.now() / 1000) },
    );
    leaveIfOpen(its);
  };

  const act: RowActions = {
    archive: (its) => doArchive(its),
    moveToInbox: (its) => {
      const archived = its.filter((i) => i.archivedAt);
      const snoozed = its.filter((i) => i.snoozedUntil);
      if (archived.length) void list.actions.unarchive(archived);
      if (snoozed.length) void list.actions.unsnooze(snoozed);
      if (!archived.length && !snoozed.length) void list.actions.unarchive(its);
      const leaves = state.folder === "archive" || state.folder === "snoozed";
      patchLocal(
        its,
        leaves ? "remove" : { archivedAt: null, snoozedUntil: null },
      );
      if (leaves) leaveIfOpen(its);
    },
    requestDelete: (its, after) => {
      const inTrash =
        its.some((i) => !!i.trashedAt) || state.folder === "trash";
      if (!inTrash) {
        // Gmail's Delete: to Trash, with Undo.
        void list.actions.trash(its);
        patchLocal(
          its,
          state.folder === "all"
            ? { trashedAt: Math.floor(Date.now() / 1000) }
            : "remove",
        );
        leaveIfOpen(its);
        after?.();
        return;
      }
      // Keyboard (#) and drag-to-Trash reach here too; the menus hide it.
      if (!isAdmin) {
        showToast({
          kind: "info",
          message: "Only an admin can delete conversations forever.",
        });
        return;
      }
      if (!its.some((i) => i.type === "person")) {
        showToast({
          kind: "info",
          message:
            "Group conversations can't be deleted forever. They stay in Trash until restored.",
        });
        return;
      }
      setConfirm({ items: its, after });
    },
    restore: (its) => {
      void list.actions.restore(its);
      patchLocal(
        its,
        state.folder === "trash" ? "remove" : { trashedAt: null },
      );
      if (state.folder === "trash") leaveIfOpen(its);
    },
    canDeleteForever: isAdmin,
    moveToCategory: (its, category) => {
      // Category overrides only apply to person rows; groups stay put.
      const senders = senderAddresses(its);
      const skipped = its.filter((i) => i.type !== "person").length;
      if (!senders.length) return;
      setCategoryOverride(senders, category)
        .then(() => {
          list.refresh();
          refreshCounts();
          const undo = () =>
            setCategoryOverride(senders, null)
              .then(() => {
                list.refresh();
                refreshCounts();
              })
              .catch(() => {});
          list.setUndo(undo);
          showToast({
            kind: "info",
            message: `${senders.length === 1 ? "Sender" : `${senders.length} senders`} moved to ${CATEGORY_LABELS[category]}. Future mail goes there too.${skipped ? ` ${skipped === 1 ? "1 group conversation" : `${skipped} group conversations`} can't change tabs and stayed put.` : ""}`,
            action: {
              label: "Undo",
              onClick: (dismiss) => {
                dismiss();
                void undo();
              },
            },
          });
        })
        .catch((e) =>
          showToast({
            kind: "error",
            message: e instanceof Error ? e.message : "Could not move sender",
          }),
        );
    },
    markRead: (its) => {
      const unread = its.filter((i) => i.unreadCount > 0);
      if (!unread.length) return;
      void list.actions.markRead(unread);
      patchLocal(unread, { unreadCount: 0 });
      list.setUndo(() => void act.markUnread(unread));
    },
    markUnread: async (its) => {
      try {
        const ids = await Promise.all(its.map(latestReceivedId));
        await Promise.all(
          ids
            .filter((x): x is string => !!x)
            .map((id) => markEmailRead(id, false)),
        );
        patchLocal(its, { unreadCount: 1 });
        list.setUndo(() => {
          void list.actions.markRead(its, { quiet: true });
          patchLocal(its, { unreadCount: 0 });
        });
        showToast({
          kind: "info",
          message:
            its.length === 1
              ? "Conversation marked as unread"
              : `${its.length} conversations marked as unread`,
          action: {
            label: "Undo",
            onClick: (dismiss) => {
              dismiss();
              list.undoLast();
            },
          },
        });
        list.refresh();
      } catch (e) {
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not mark unread",
        });
      }
    },
    snooze: (its, until) => {
      void list.actions.snooze(its, until);
      patchLocal(
        its,
        state.folder === "inbox" ? "remove" : { snoozedUntil: until },
      );
      leaveIfOpen(its);
    },
    pickSnooze: (its, after) => setPick({ items: its, presets: true, after }),
    star: (its, value) => {
      const v = value ?? !its.every((t) => t.starred);
      void list.actions.toggleStar(its, v);
      patchLocal(
        its,
        state.folder === "starred" && !v ? "remove" : { starred: v },
      );
    },
    pin: (its, value) => {
      const v = value ?? !its.every((t) => t.pinned);
      void list.actions.togglePin(its, v);
      patchLocal(its, { pinned: v });
    },
    respond: (item, how) => open(item, { action: how }),
    findFrom: (item) =>
      navigate(
        `/${buildListSearch({ folder: "all", from: senderEmail(item) })}`,
      ),
    openInNewWindow: (item) =>
      window.open(
        `/?open=${encodeURIComponent(openParam(item))}`,
        "_blank",
        "noopener",
      ),
    showLabel: (address) =>
      navigate(`/${buildListSearch({ folder: "all", label: address })}`),
  };
  /** Bulk actions on every row matching the view ("Select all N"). */
  const doAll = (
    patch: Parameters<typeof list.actions.applyToAll>[0],
    message: string,
    undo?: Parameters<typeof list.actions.applyToAll>[2],
  ) => {
    void list.actions.applyToAll(patch, message, undo);
    clearSelection();
  };
  const deleteForeverAll = async () => {
    try {
      const { data } = await fetchGroupedIds(list.folderParams());
      const people = data.filter((r) => r.type === "person");
      for (let i = 0; i < people.length; i += 8)
        await Promise.all(
          people.slice(i, i + 8).map((p) => deletePerson(p.id)),
        );
      showToast({
        kind: "success",
        message: `${people.length} conversation${people.length === 1 ? "" : "s"} deleted forever`,
      });
      clearSelection();
      list.refresh();
      refreshCounts();
    } catch (e) {
      showToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not delete",
      });
    }
  };
  const allAct: RowActions = {
    ...act,
    archive: () =>
      doAll({ archived: true }, "{n} conversations archived", {
        archived: false,
      }),
    moveToInbox: () =>
      doAll(
        { archived: false, snoozedUntil: null },
        "{n} conversations moved to Inbox",
      ),
    restore: () =>
      doAll({ trashed: false }, "{n} conversations restored", {
        trashed: true,
      }),
    requestDelete: () =>
      state.folder === "trash"
        ? isAdmin
          ? setConfirm({ items: [], all: true })
          : showToast({
              kind: "info",
              message: "Only an admin can delete conversations forever.",
            })
        : doAll({ trashed: true }, "{n} conversations moved to Trash", {
            trashed: false,
          }),
    markRead: () => {
      void list.actions.markAllRead();
      clearSelection();
    },
    markUnread: async () => {
      const refs = allRefs ?? [];
      try {
        for (let i = 0; i < refs.length; i += 8) {
          const ids = await Promise.all(
            refs
              .slice(i, i + 8)
              .map((r) => latestReceivedId(r as unknown as GroupedItem)),
          );
          await Promise.all(
            ids
              .filter((x): x is string => !!x)
              .map((id) => markEmailRead(id, false)),
          );
        }
        showToast({
          kind: "info",
          message: `${refs.length} conversations marked as unread`,
        });
        clearSelection();
        list.refresh();
      } catch (e) {
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not mark unread",
        });
      }
    },
    snooze: (_its, until) =>
      doAll({ snoozedUntil: until }, "{n} conversations snoozed", {
        snoozedUntil: null,
      }),
    pickSnooze: () => setPick({ items: [], presets: true, all: true }),
    star: (_its, value) =>
      doAll(
        { starred: value ?? true },
        `{n} conversations ${value === false ? "unstarred" : "starred"}`,
        {
          starred: !(value ?? true),
        },
      ),
    pin: (_its, value) =>
      doAll(
        { pinned: value ?? true },
        `{n} conversations ${value === false ? "unpinned" : "pinned"}`,
        {
          pinned: !(value ?? true),
        },
      ),
  };

  const actRef = useRef(act);
  actRef.current = act;

  /* ── drag and drop onto nav ── */
  const dragItems = useRef<GroupedItem[]>([]);
  const [draggingKeys, setDraggingKeys] = useState<Set<string>>(new Set());
  const onRowDragStart = (e: React.DragEvent, item: GroupedItem) => {
    const k = itemKey(item);
    const items =
      selectedKeys.has(k) && selected.length > 0 ? selected : [item];
    dragItems.current = items;
    setDraggingKeys(new Set(items.map(itemKey)));
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_MIME, String(items.length));
    e.dataTransfer.setData("text/plain", items.map(itemTitle).join(", "));
    try {
      e.dataTransfer.setDragImage(dragGhost(items.length), 12, 12);
    } catch {
      /* some browsers refuse custom drag images */
    }
    startRowDrag(items.length);
  };
  const onRowDragEnd = () => {
    setDraggingKeys(new Set());
    endRowDrag();
  };
  useEffect(
    () =>
      onRowDrop((target) => {
        const items = dragItems.current;
        dragItems.current = [];
        setDraggingKeys(new Set());
        endRowDrag();
        if (!items.length) return;
        const a = actRef.current;
        if (target === "archive") a.archive(items);
        else if (target === "inbox") a.moveToInbox(items);
        else if (target === "starred") a.star(items, true);
        else if (target === "snoozed") a.pickSnooze(items);
        else if (target === "trash") a.requestDelete(items);
        setSelectedKeys(new Set());
      }),
    [],
  );

  /* ── conversation navigation ── */
  const openIndex = openItem
    ? displayed.findIndex((it) => itemKey(it) === itemKey(openItem))
    : -1;
  const goAdjacent = (delta: number) => {
    const target = displayed[openIndex + delta];
    if (target) open(target, { replace: true });
    else back();
  };

  const convHandle = useRef<ConversationHandle | null>(null);

  /* ── keyboard shortcuts ── */
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const keyState = useRef({
    displayed,
    focused,
    focusedIndex,
    openItem,
    openIndex,
    selected,
    pane,
    kbdNav,
  });
  keyState.current = {
    displayed,
    focused,
    focusedIndex,
    openItem,
    openIndex,
    selected,
    pane,
    kbdNav,
  };
  const prefixRef = useRef<{ p: ShortcutPrefix; t: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"], [data-testid="gmail-quick-settings"], [data-testid="gmail-drawer"], [data-testid="gmail-m-search-screen"], [data-testid="reply-composer"]:focus-within',
        )
      )
        return;
      const s = keyState.current;
      const a = actRef.current;
      if (e.key === "Escape") {
        if (s.selected.length) {
          clearSelection();
          e.preventDefault();
        }
        return;
      }
      const pending =
        prefixRef.current && Date.now() - prefixRef.current.t < 1500
          ? prefixRef.current.p
          : null;
      prefixRef.current = null;
      const res = resolveShortcut(e, pending);
      if (res.prefix) {
        prefixRef.current = { p: res.prefix, t: Date.now() };
        e.preventDefault();
        return;
      }
      const cmd = res.cmd;
      if (!cmd) return;
      const targets = s.openItem
        ? [s.openItem]
        : s.selected.length
          ? s.selected
          : s.focused
            ? [s.focused]
            : [];
      const moveFocus = (delta: number) => {
        const base =
          s.kbdNav || s.pane !== "none" ? s.focusedIndex : delta > 0 ? -1 : 1;
        const i = Math.min(s.displayed.length - 1, Math.max(0, base + delta));
        const it = s.displayed[i];
        if (!it) return;
        setKbdNav(true);
        setFocusedKey(itemKey(it));
        if (s.pane !== "none") open(it, { replace: true });
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(
            `[data-key="${CSS.escape(itemKey(it))}"]`,
          );
          el?.scrollIntoView({ block: "nearest" });
          el?.focus({ preventScroll: true });
        });
      };
      const go = (search: Partial<ListState>) =>
        navigate(`/${buildListSearch(search)}`);
      let handled = true;
      switch (cmd) {
        case "compose":
          onCompose();
          break;
        case "search":
          if (isMobile) setSearchOpen(true);
          else focusSearch();
          break;
        case "help":
          openShortcuts();
          break;
        case "goInbox":
          go({ folder: "inbox" });
          break;
        case "goStarred":
          go({ folder: "starred" });
          break;
        case "goSent":
          go({ folder: "sent" });
          break;
        case "goDrafts":
          go({ folder: "drafts" });
          break;
        case "goArchive":
          go({ folder: "archive" });
          break;
        case "goSnoozed":
          go({ folder: "snoozed" });
          break;
        case "goTrash":
          go({ folder: "trash" });
          break;
        case "selectAll":
          selectPreset("all");
          break;
        case "selectNone":
          selectPreset("none");
          break;
        case "selectRead":
          selectPreset("read");
          break;
        case "selectUnread":
          selectPreset("unread");
          break;
        case "selectStarred":
          selectPreset("starred");
          break;
        case "selectUnstarred":
          selectPreset("unstarred");
          break;
        case "next":
          if (s.openItem && s.pane === "none") goAdjacent(1);
          else moveFocus(1);
          break;
        case "prev":
          if (s.openItem && s.pane === "none") goAdjacent(-1);
          else moveFocus(-1);
          break;
        case "open":
          if (s.focused && (!s.openItem || s.pane !== "none")) open(s.focused);
          else handled = false;
          break;
        case "back":
          if (s.openItem) back();
          break;
        case "select":
          if (s.focused) toggleSelect(s.focused);
          break;
        case "archive":
          if (targets.length) a.archive(targets);
          break;
        case "archiveOlder":
        case "archiveNewer": {
          if (!targets.length) break;
          const delta = cmd === "archiveOlder" ? 1 : -1;
          const next = s.openItem ? s.displayed[s.openIndex + delta] : null;
          a.archive(targets);
          if (next) window.setTimeout(() => open(next, { replace: true }), 0);
          break;
        }
        case "star":
          if (targets.length) a.star(targets);
          break;
        case "delete":
          if (targets.length) a.requestDelete(targets);
          break;
        case "markRead":
          if (targets.length) a.markRead(targets);
          break;
        case "markUnread":
          if (targets.length)
            void a.markUnread(targets).then(() => s.openItem && back());
          break;
        case "snooze":
          if (targets.length) setPick({ items: targets, presets: true });
          break;
        case "undo":
          list.undoLast();
          break;
        case "moreActions": {
          if (!targets.length) break;
          const el = s.focused
            ? document.querySelector<HTMLElement>(
                `[data-key="${CSS.escape(itemKey(s.focused))}"]`,
              )
            : null;
          const r = el?.getBoundingClientRect();
          setMenu({
            x: r ? r.left + 240 : window.innerWidth / 2,
            y: r ? r.bottom : 120,
            items: targets,
          });
          break;
        }
        case "reply":
        case "replyAll":
        case "forward":
        case "expandAll":
        case "collapseAll":
        case "nextMessage":
        case "prevMessage":
          if (s.openItem && convHandle.current) convHandle.current[cmd]();
          else if (
            !s.openItem &&
            s.focused &&
            (cmd === "reply" || cmd === "replyAll" || cmd === "forward")
          )
            a.respond(s.focused, cmd);
          else handled = false;
          break;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isMobile,
    onCompose,
    focusSearch,
    openShortcuts,
    open,
    back,
    toggleSelect,
    selectPreset,
    list.undoLast,
  ]);

  /* ── document title ── */
  const unreadTotal = shell.counts.inboxUnread;
  const folderName = searching
    ? "Search results"
    : state.label
      ? labelName(
          state.label,
          identities.find((s) => s.email === state.label)?.displayName,
        )
      : showTabs
        ? CATEGORY_LABELS[activeTab]
        : FOLDER_LABELS[state.folder];
  useEffect(() => {
    const who = session?.user?.email ? ` - ${session.user.email}` : "";
    const count =
      state.folder === "inbox" && unreadTotal > 0 ? ` (${unreadTotal})` : "";
    const base =
      state.folder === "inbox" && !searching && !state.label
        ? "Inbox"
        : folderName;
    document.title = `${base}${count}${who} - ${brandName}`;
  }, [
    folderName,
    unreadTotal,
    session?.user?.email,
    brandName,
    state.folder,
    searching,
    state.label,
  ]);

  /* ── mobile: scroll, pull, infinite ── */
  const [fabExtended, setFabExtended] = useState(true);
  const lastScroll = useRef(0);
  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const st = e.currentTarget.scrollTop;
    if (st > lastScroll.current + 6) setFabExtended(false);
    else if (st < lastScroll.current - 6 || st < 8) setFabExtended(true);
    lastScroll.current = st;
  };

  const doRefresh = useCallback(() => {
    setEarlier([]);
    if (list.page !== 1) list.setPage(1);
    else list.refresh();
    refreshCounts();
    return new Promise<void>((r) => setTimeout(r, 700));
  }, [list, refreshCounts]);

  const pull = usePullToRefresh<HTMLDivElement>({
    onRefresh:
      isMobile && !openItem && selectedKeys.size === 0 ? doRefresh : undefined,
  });

  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMore = isMobile && list.loading && earlier.length > 0;
  useEffect(() => {
    if (!isMobile || openItem) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (list.loading || list.page >= list.pageCount) return;
        setEarlier((prev) => dedupe([...prev, ...list.items]));
        list.setPage(list.page + 1);
      },
      { root: pull.ref.current, rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [isMobile, openItem, list, pull.ref]);

  /* ── shared bits ── */
  const showLabels = !state.label && labels.length > 1;
  const initialLoading =
    list.loading && list.items.length === 0 && earlier.length === 0;

  const setListState = (s: ListState) => navigate(`/${buildListSearch(s)}`);

  const dialogs = (
    <>
      <ConfirmDialog
        open={!!confirm}
        title={
          confirm?.all
            ? "Empty Trash?"
            : confirm &&
                confirm.items.filter((i) => i.type === "person").length > 1
              ? `Delete ${confirm.items.filter((i) => i.type === "person").length} conversations forever?`
              : "Delete forever?"
        }
        body={
          (confirm?.all
            ? "Every person in Trash, with all their mail and attachments, will be deleted for the whole team, not just removed from your Trash. This can't be undone."
            : (confirm &&
              confirm.items.filter((i) => i.type === "person").length > 1
                ? "This deletes these people and all their mail and attachments"
                : "This deletes this person and all their mail and attachments") +
              " for the whole team, not just from your Trash. This can't be undone.") +
          (confirm?.all || confirm?.items.some((i) => i.type === "group")
            ? " Group conversations stay in Trash (they can only be restored)."
            : "")
        }
        confirmLabel={confirm?.all ? "Empty Trash" : "Delete forever"}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.all) {
            void deleteForeverAll();
            return;
          }
          const people = confirm.items.filter((i) => i.type === "person");
          void list.actions.deleteForever(people);
          patchLocal(people, "remove");
          leaveIfOpen(people);
          confirm.after?.();
        }}
        onClose={() => setConfirm(null)}
      />
      <PickDateDialog
        open={!!pick}
        presets={pick?.presets}
        onClose={() => setPick(null)}
        onPick={(until) => {
          if (!pick) return;
          if (pick.all) allAct.snooze([], until);
          else act.snooze(pick.items, until);
          pick.after?.();
        }}
      />
      <RowMenu state={menu} onClose={() => setMenu(null)} act={act} />
    </>
  );

  const offlineBanner = !online && (
    <div
      className="gm-offline flex flex-none items-center justify-center gap-2 px-4 py-2 text-sm"
      role="status"
    >
      <WifiOff size={16} /> You're offline. Showing what was last loaded;
      changes need a connection.
    </div>
  );

  const errorBox = (
    <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <p className="text-sm text-text-secondary">
        Couldn't load your mail.{" "}
        {online ? list.error : "Check your connection."}
      </p>
      <button
        type="button"
        className="gm-pill-btn"
        onClick={() => list.refresh()}
      >
        <RotateCw size={18} /> Try again
      </button>
    </div>
  );

  const onContextMenu = (e: React.MouseEvent, item: GroupedItem) => {
    e.preventDefault();
    const k = itemKey(item);
    const items =
      selectedKeys.has(k) && selected.length > 1 ? selected : [item];
    setFocusedKey(k);
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const renderRows = (rows: GroupedItem[], narrow: boolean) =>
    rows.map((it) => (
      <MailRow
        key={itemKey(it)}
        item={it}
        folder={state.folder}
        selected={selectedKeys.has(itemKey(it)) || !!allRefs}
        focused={
          (kbdNav && focused ? itemKey(focused) === itemKey(it) : false) ||
          (pane !== "none" && openKey === itemKey(it))
        }
        dragging={draggingKeys.has(itemKey(it))}
        showLabels={showLabels}
        identities={identities}
        act={act}
        onOpen={open}
        onToggleSelect={toggleSelect}
        onFocus={(x) => setFocusedKey(itemKey(x))}
        onContextMenu={onContextMenu}
        onDragStart={onRowDragStart}
        onDragEnd={onRowDragEnd}
        narrow={narrow}
      />
    ));

  const sectioned = (rows: GroupedItem[], narrow: boolean) => {
    if (inboxType === "default") return renderRows(rows, narrow);
    const isFirst = (it: GroupedItem) =>
      inboxType === "unread" ? it.unreadCount > 0 : it.starred;
    const byDate = (a: GroupedItem, b: GroupedItem) =>
      b.lastEmailAt - a.lastEmailAt;
    const first = rows.filter(isFirst).sort(byDate);
    const rest = rows.filter((r) => !isFirst(r)).sort(byDate);
    return (
      <>
        <div className="gm-section-head">
          {inboxType === "unread" ? "Unread" : "Starred"}
          {priority && (
            <span className="ml-auto text-xs font-normal text-text-secondary">
              {priority.total > first.length
                ? `1–${first.length} of ${priority.total.toLocaleString()}`
                : priority.total.toLocaleString()}
            </span>
          )}
        </div>
        {first.length ? (
          renderRows(first, narrow)
        ) : (
          <p className="px-4 py-3 text-sm text-text-secondary">
            {inboxType === "unread"
              ? "Woohoo! You've read all the messages in your inbox."
              : "No starred conversations on this page."}
          </p>
        )}
        <div className="gm-section-head">Everything else</div>
        {renderRows(rest, narrow)}
      </>
    );
  };

  const listBody = (narrow: boolean) => {
    if (list.error && list.items.length === 0) return errorBox;
    if (initialLoading) return isMobile ? <MobileSkeleton /> : <SkeletonRows />;
    if (displayed.length === 0)
      return <EmptyState state={state} onCompose={() => onCompose()} />;
    if (isMobile)
      return (
        <MobileRows
          items={displayed}
          folder={state.folder}
          selectedKeys={selectedKeys}
          act={act}
          onOpen={open}
          onToggleSelect={(it) => toggleSelect(it)}
          swipeLeft={view.swipeLeft}
          swipeRight={view.swipeRight}
        />
      );
    return (
      <div role="grid" aria-label={folderName} aria-rowcount={displayed.length}>
        {sectioned(displayed, narrow)}
      </div>
    );
  };

  const position =
    openItem && openIndex >= 0
      ? {
          index: (list.page - 1) * PAGE_SIZE + openIndex + 1,
          total: list.total,
        }
      : undefined;

  const clearDo = () => {
    if (!params.get("do")) return;
    const p = new URLSearchParams(params);
    p.delete("do");
    navigate(`${location.pathname}?${p.toString()}`, { replace: true });
  };

  const conversation = (mobile: boolean, inPane: boolean) =>
    openItem ? (
      <Conversation
        key={itemKey(openItem)}
        item={openItem}
        stats={stats}
        act={act}
        onBack={back}
        onCompose={onCompose}
        position={position}
        onPrev={openIndex > 0 ? () => goAdjacent(-1) : undefined}
        onNext={
          openIndex >= 0 && openIndex < displayed.length - 1
            ? () => goAdjacent(1)
            : undefined
        }
        mobile={mobile}
        pane={inPane}
        handleRef={convHandle}
        onChanged={list.refresh}
        focusMessageId={
          location.hash.startsWith("#m=") ? location.hash.slice(3) : null
        }
        initialAction={initialAction}
        onActionDone={clearDo}
        backLabel={`Back to ${showTabs ? "Inbox" : folderName}`}
        onOpenNewWindow={() => act.openInNewWindow(openItem)}
      />
    ) : null;

  /* ── mobile ── */
  if (isMobile) {
    if (openItem || openRef) {
      return (
        <div
          className="gm-m-screen flex min-h-0 flex-1 flex-col"
          data-thread-open
        >
          {offlineBanner}
          {conversation(true, false) ?? (
            <div className="flex flex-1 items-center justify-center">
              <span className="gm-skel h-10 w-10 rounded-full" />
            </div>
          )}
          {dialogs}
        </div>
      );
    }
    const query = searching || state.label ? stateToQuery(state, labels) : "";
    return (
      <div
        className="gm-m-screen relative flex min-h-0 flex-1 flex-col"
        data-testid="gmail-mobile-list"
      >
        <div className="flex-none pt-[calc(8px+env(safe-area-inset-top))]">
          {selected.length > 0 ? (
            <MobileSelectionBar
              selected={selected}
              folder={state.folder}
              act={act}
              onClear={clearSelection}
            />
          ) : (
            <div className="pb-1">
              <MobileSearchBar
                value={query}
                onChange={() => {}}
                inputRef={mobileSearchRef}
                searching={searching || !!state.label}
                onSubmit={() => {}}
                onActivate={() => setSearchOpen(true)}
                onClear={() => navigate("/")}
                onMenu={shell.openDrawer}
                onAccount={shell.openAccount}
              />
            </div>
          )}
          {searching && (
            <SearchChips
              state={state}
              labels={labels}
              senders={displayed}
              onChange={setListState}
              compact
            />
          )}
        </div>
        {offlineBanner}
        <div
          ref={pull.ref}
          onScroll={onListScroll}
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <PullIndicator
            distance={pull.pullDistance}
            refreshing={pull.refreshing}
            threshold={pull.threshold}
          />
          <div
            style={{
              transform: pull.pullDistance
                ? `translateY(${Math.min(pull.pullDistance, 90) * 0.5}px)`
                : undefined,
            }}
          >
            <p className="px-4 pb-1 pt-3 text-sm font-medium text-text-secondary">
              {searching
                ? `Results in ${state.folder === "all" ? "all mail" : FOLDER_LABELS[state.folder]}`
                : folderName}
            </p>
            {showTabs && activeTab === "primary" && (
              <CategoryRows
                counts={shell.counts.categoriesNew}
                onOpen={(c) =>
                  navigate(`/${buildListSearch({ folder: "inbox", tab: c })}`)
                }
              />
            )}
            {listBody(false)}
            <div ref={sentinelRef} className="h-px" />
            {loadingMore && (
              <div className="flex justify-center py-4">
                <RotateCw size={20} className="animate-spin text-accent" />
              </div>
            )}
            {!list.loading &&
              list.page >= list.pageCount &&
              displayed.length > 8 && (
                <p className="py-6 text-center text-xs text-text-tertiary">
                  That's everything in {folderName}
                </p>
              )}
            <div className="h-24" />
          </div>
        </div>
        {selected.length === 0 && (
          <ComposeFab extended={fabExtended} onClick={() => onCompose()} />
        )}
        {searchOpen && (
          <MobileSearchScreen
            initial={query}
            labels={labels}
            onClose={() => setSearchOpen(false)}
          />
        )}
        {dialogs}
      </div>
    );
  }

  /* ── desktop ── */
  const pageAllSelected =
    displayed.length > 0 && pageSelected.length === displayed.length;
  const toolbar = (
    <ListToolbar
      items={displayed}
      selected={selected}
      folder={state.folder}
      act={allRefs ? allAct : act}
      allMode={!!allRefs}
      onSelectPreset={selectPreset}
      onRefresh={() => {
        list.refresh();
        refreshCounts();
      }}
      onMarkAllRead={() => void list.actions.markAllRead()}
      range={rangeLabel(list.page, PAGE_SIZE, list.total)}
      canPrev={list.page > 1}
      canNext={list.page < list.pageCount}
      onPrev={() => list.setPage(list.page - 1)}
      onNext={() => list.setPage(list.page + 1)}
    />
  );

  const listPanel = (narrow: boolean) => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {toolbar}
      {searching && (
        <>
          <div className="flex items-baseline gap-2 px-4 pt-1 text-sm">
            <span className="font-medium text-text-primary">Results</span>
            {!list.loading && (
              <span className="text-text-secondary">
                {list.total.toLocaleString()} conversation
                {list.total === 1 ? "" : "s"}
                {state.folder !== "all" && ` in ${FOLDER_LABELS[state.folder]}`}
              </span>
            )}
          </div>
          <SearchChips
            state={state}
            labels={labels}
            senders={displayed}
            onChange={setListState}
          />
        </>
      )}
      {showTabs && (
        <CategoryTabs
          active={activeTab}
          counts={shell.counts.categoriesNew}
          onSelect={(c) =>
            navigate(`/${buildListSearch({ folder: "inbox", tab: c })}`)
          }
        />
      )}
      {(pageAllSelected || allRefs) && list.total > displayed.length && (
        <SelectAllBanner
          pageCount={displayed.length}
          total={allRefs?.length ?? list.total}
          where={folderWhere}
          allSelected={!!allRefs}
          loading={allLoading}
          onSelectAll={() => {
            setAllLoading(true);
            list
              .fetchAll()
              .then((all) => setAllRefs(all))
              .catch(() =>
                showToast({ kind: "error", message: "Could not select all" }),
              )
              .finally(() => setAllLoading(false));
          }}
          onClear={clearSelection}
        />
      )}
      {offlineBanner}
      {state.folder === "trash" && !searching && displayed.length > 0 && (
        <div
          className="flex flex-none items-center justify-center gap-3 border-b border-border bg-bg-subtle px-4 py-2 text-sm"
          data-testid="gmail-trash-banner"
        >
          <span className="text-text-secondary">
            Conversations in Trash are hidden everywhere else. New mail brings
            one back.
          </span>
          {isAdmin && (
            <button
              type="button"
              className="font-medium text-accent hover:underline"
              onClick={() => setConfirm({ items: [], all: true })}
              data-testid="gmail-empty-trash"
            >
              Empty Trash now
            </button>
          )}
        </div>
      )}
      <div
        className={cn(
          "gm-list min-h-0 flex-1 overflow-y-auto",
          !showTabs && !searching && "border-t border-border",
        )}
        data-density={density}
      >
        {listBody(narrow)}
        {displayed.length > 0 && (
          <p className="py-6 text-center text-xs text-text-tertiary">
            {rangeLabel(list.page, PAGE_SIZE, list.total)}
            {" · "}
            <button
              type="button"
              className="hover:underline"
              onClick={openShortcuts}
            >
              Keyboard shortcuts
            </button>
            {" · "}
            <button
              type="button"
              className="hover:underline"
              onClick={shell.openQuickSettings}
            >
              Display settings
            </button>
          </p>
        )}
      </div>
    </div>
  );

  const emptyPane = (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-text-tertiary">
      <span className="text-sm">No conversations selected</span>
    </div>
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 overflow-hidden rounded-2xl bg-card",
        pane === "below" && "flex-col",
      )}
      data-testid="gmail-inbox"
    >
      {pane === "right" ? (
        <>
          <div className="flex min-h-0 w-[46%] min-w-[380px] flex-none flex-col border-r border-border">
            {listPanel(true)}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {conversation(false, true) ?? emptyPane}
          </div>
        </>
      ) : pane === "below" ? (
        <>
          <div className="flex h-1/2 min-h-0 flex-none flex-col border-b border-border">
            {listPanel(false)}
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {conversation(false, true) ?? emptyPane}
          </div>
        </>
      ) : openItem || openRef ? (
        (conversation(false, false) ?? (
          <div className="flex flex-1 items-center justify-center">
            <span className="gm-skel h-10 w-10 rounded-full" />
          </div>
        ))
      ) : (
        listPanel(false)
      )}
      {dialogs}
    </div>
  );
}
