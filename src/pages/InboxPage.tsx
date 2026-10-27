import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, useOutletContext, useSearchParams } from "react-router-dom";
import { Loader2, Mail, Trash2 } from "lucide-react";

import type { ComposePrefill } from "@/pages/ComposeModal";

interface InboxOutletContext {
  onCompose: (prefill?: ComposePrefill) => void;
}
import PersonList from "./PersonList";
import PersonDetail from "./PersonDetail";
import InboxToolbar, {
  type InboxFilters,
  type InboxView,
} from "@/components/InboxToolbar";
import PeopleTable from "@/components/PeopleTable";
import SelectionBar from "@/components/SelectionBar";
import AgentPlan from "@/components/AgentPlan";
import {
  addBlock,
  EMPTY_MAIL_ROW_STATE,
  deletePerson,
  fetchPerson,
  fetchStats,
  fetchGroupedPeople,
  markPeopleRead,
  markConversationsRead,
  setCategoryOverride,
  updateMailState,
  type GroupedItem,
  type MailCategory,
  type MailFolder,
  type MailItemRef,
  type GroupedPerson,
  type GroupedConversation,
  type InboxAggregates,
  type InboxSortSpec,
  type Stats,
} from "@/lib/api";
import {
  applyToFolder,
  applyToRefs,
  deleteFolderForever,
  markFolderRead,
} from "@/lib/folder-actions";
import {
  parseInboxSort,
  useDefaultLayoutSettings,
} from "@/lib/default-layout-settings";
import ConversationDetail from "./ConversationDetail";
import { useSession } from "@/lib/auth-client";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { onInboxRefresh } from "@/lib/inbox-events";
import { useResizableSidebar } from "@/hooks/useResizableSidebar";
import { cn } from "@/lib/utils";
import { PushOptInBanner } from "@/components/PushOptInBanner";
import { isPushSupported, hasDismissedPrompt } from "@/lib/push";
import { showToast } from "@/lib/toast";
import { itemRef } from "@/hooks/useMailList";
import {
  CATEGORY_LABELS,
  type MailActionHandlers,
  type MailStateLike,
} from "@/components/MailActions";
import {
  MAIL_VIEWS,
  activeMailView,
  folderFromParams,
} from "@/components/shell/nav";
import { refreshMailCounts } from "@/components/shell/useMailCounts";
import SnoozeDialog from "@/components/SnoozeDialog";
import { goChord, shouldIgnoreKey } from "@/lib/shortcuts";
import { shellStore } from "@/components/shell/shellStore";

const keyOf = (it: { type: string; id: string }) => `${it.type}:${it.id}`;

/**
 * "r": put the caret in the open conversation's reply box. Chat inboxes
 * have a quick-reply field; thread inboxes open the reply composer on the
 * latest message. Polls briefly because the conversation may still be
 * loading.
 */
function focusReplyWhenReady(tries = 25) {
  const pane = document.getElementById("pt-reading");
  const quick = pane?.querySelector<HTMLTextAreaElement>("textarea");
  if (quick && !quick.disabled) {
    quick.focus();
    return;
  }
  const editor = pane?.querySelector<HTMLElement>(
    '[data-testid="reply-composer"] .ProseMirror',
  );
  if (editor) {
    editor.focus();
    return;
  }
  const last = Array.from(
    pane?.querySelectorAll<HTMLElement>('[data-testid="thread-message"]') ?? [],
  ).pop();
  const btn = Array.from(last?.querySelectorAll("button") ?? []).find(
    (b) => b.textContent?.trim() === "Reply",
  );
  if (btn) {
    btn.click();
    window.setTimeout(() => focusReplyWhenReady(10), 120);
    return;
  }
  if (tries > 0) window.setTimeout(() => focusReplyWhenReady(tries - 1), 120);
}

/** The row button for a list key, for focus and scrolling. */
function rowElement(key: string): HTMLElement | null {
  const [type, id] = [
    key.slice(0, key.indexOf(":")),
    key.slice(key.indexOf(":") + 1),
  ];
  const sel =
    type === "person"
      ? `[data-testid="person-row"][data-person-id="${CSS.escape(id)}"]`
      : `[data-testid="group-row"][data-conversation-id="${CSS.escape(id)}"]`;
  return document.querySelector<HTMLElement>(sel);
}

type StatePatch = {
  starred?: boolean;
  pinned?: boolean;
  archived?: boolean;
  snoozedUntil?: number | null;
  trashed?: boolean;
};

const FOLDER_EMPTY: Record<string, string> = {
  inbox: "You're all caught up",
  starred: "No starred conversations",
  snoozed: "Nothing is snoozed",
  archive: "The archive is empty",
  sent: "Nothing sent yet",
  drafts: "No drafts in progress",
  sequenced: "Nobody is in a sequence",
  trash: "Trash is empty",
};

const PEOPLE_PAGE_SIZE = 40;

export default function InboxPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const outlet = useOutletContext<InboxOutletContext | null>();
  const onCompose = outlet?.onCompose ?? (() => {});
  const [selectedPerson, setSelectedPerson] = useState<GroupedPerson | null>(
    null,
  );
  const [selectedConversation, setSelectedConversation] =
    useState<GroupedConversation | null>(null);
  const [items, setItems] = useState<GroupedItem[]>([]);
  // Keyboard cursor: the row j/k last moved to (or the open one).
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const cursorKeyRef = useRef(cursorKey);
  cursorKeyRef.current = cursorKey;
  // The most recent undoable change, for the "z" shortcut.
  const lastUndoRef = useRef<(() => void) | null>(null);
  const [snoozeTargets, setSnoozeTargets] = useState<GroupedItem[] | null>(
    null,
  );
  const openRow = useCallback((it: GroupedItem) => {
    if (it.type === "person") {
      setSelectedConversation(null);
      setSelectedPerson(it);
    } else {
      setSelectedPerson(null);
      setSelectedConversation(it);
    }
  }, []);
  const [peopleTotal, setPeopleTotal] = useState(0);
  const [peoplePage, setPeoplePage] = useState(1);
  const [peopleLoading, setPeopleLoading] = useState(true);
  // Server-side aggregates over the *filtered* set so the table's
  // stat tiles reflect the whole result, not just the visible page.
  const [aggregates, setAggregates] = useState<InboxAggregates>({
    unreadRowCount: 0,
    attachmentRowCount: 0,
    multiInboxRowCount: 0,
    totalUnreadEmails: 0,
  });
  const [stats, setStats] = useState<Stats | null>(null);
  // Deep-link support: seed search from `?q=` and the Drafts /
  // Sequenced filters from `?drafts=1` / `?sequenced=1` so an external link —
  // or a WebMCP action that just saved a draft or enrolled a contact — lands
  // on the right pre-filtered view.
  const [searchParams, setSearchParams] = useSearchParams();
  // The "Agent Plan" tab is URL-driven (`?view=agent-plan`) so the WebMCP
  // `visualize_plan` tool can open it by navigation, just like the filters.
  const agentPlanOpen = searchParams.get("view") === "agent-plan";
  const toggleAgentPlan = () =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (next.get("view") === "agent-plan") next.delete("view");
        else next.set("view", "agent-plan");
        return next;
      },
      { replace: true },
    );
  const draftsParam =
    searchParams.get("drafts") === "1" || searchParams.get("drafts") === "true";
  const sequencedParam =
    searchParams.get("sequenced") === "1" ||
    searchParams.get("sequenced") === "true";
  // Folder, inbox address, Drafts and Sequenced live in the URL so the rail
  // (and WebMCP navigations) can select them. Unread stays local.
  const folder: MailFolder = folderFromParams(searchParams);
  const recipientParam = searchParams.get("inbox") || undefined;
  const mailView = activeMailView(searchParams);
  const queryFolder: MailFolder =
    draftsParam || sequencedParam ? "all" : folder;
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [category, setCategory] = useState<MailCategory | undefined>();
  const filters: InboxFilters = useMemo(
    () => ({
      recipient: recipientParam,
      unread: unreadOnly,
      drafts: draftsParam,
      sequenced: sequencedParam,
      category,
    }),
    [recipientParam, unreadOnly, draftsParam, sequencedParam, category],
  );
  const setFilters = useCallback(
    (next: InboxFilters) => {
      setUnreadOnly(!!next.unread);
      setCategory(next.category);
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          if (next.recipient) sp.set("inbox", next.recipient);
          else sp.delete("inbox");
          if (next.drafts) sp.set("drafts", "1");
          else sp.delete("drafts");
          if (next.sequenced) sp.set("sequenced", "1");
          else sp.delete("sequenced");
          return sp;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const urlQuery = searchParams.get("q");
  const [search, setSearch] = useState(() => urlQuery ?? "");
  // A search linked from elsewhere (the command palette's "Search mail
  // for …") while already on the inbox: adopt the new ?q=.
  useEffect(() => {
    if (urlQuery !== null) setSearch(urlQuery);
  }, [urlQuery]);
  const [view, setView] = useState<InboxView>("list");
  // Sort is an account setting (follows the user to other devices).
  const [layoutSettings, setLayoutSettings] = useDefaultLayoutSettings();
  const savedSort = parseInboxSort(layoutSettings.inboxSort);
  const sortSpec: InboxSortSpec = useMemo(
    () => savedSort ?? { key: "recency", direction: "desc" },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [savedSort?.key, savedSort?.direction],
  );
  const setSortSpec = useCallback(
    (spec: InboxSortSpec) => setLayoutSettings({ inboxSort: spec }),
    [setLayoutSettings],
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedConversationIds, setSelectedConversationIds] = useState<
    Set<string>
  >(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Manual refresh (desktop button / mobile pull-to-refresh) — separate from
  // `peopleLoading` so a refresh keeps the current list visible (just a
  // spinner) instead of flashing the full-pane "Loading…" placeholder.
  const [refreshing, setRefreshing] = useState(false);

  // Resizable sidebar — the user can drag the right edge to make the
  // people list narrower (down to "just avatar + unread badge" mode).
  const { width: sidebarWidth, startDrag, isCompact } = useResizableSidebar();
  const [isNarrow, setIsNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767.98px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767.98px)");
    const on = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Reset to page 1 whenever the query inputs change. (Direction
  // change keeps the page — the user usually wants to keep looking at
  // the same window when they flip asc/desc.)
  useEffect(() => {
    setPeoplePage(1);
  }, [
    search,
    filters.recipient,
    filters.unread,
    filters.drafts,
    filters.sequenced,
    filters.category,
    queryFolder,
    sortSpec.key,
  ]);

  // Switching folder starts a fresh selection.
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectedConversationIds(new Set());
  }, [queryFolder, filters.drafts, filters.sequenced]);

  // The current people query, derived from search + filters + sort + page.
  // Shared by the debounced auto-load below and the manual refresh path so
  // both always hit the same parameters.
  // What "the whole folder" means for folder-wide actions (mark all read,
  // "Select all N", Empty Trash): the folder plus every active filter.
  const folderQuery = useMemo(
    () => ({
      q: search || undefined,
      recipient: filters.recipient,
      unread: filters.unread,
      drafts: filters.drafts,
      sequenced: filters.sequenced,
      category: filters.category,
      folder: queryFolder,
    }),
    [
      search,
      filters.recipient,
      filters.unread,
      filters.drafts,
      filters.sequenced,
      filters.category,
      queryFolder,
    ],
  );
  const peopleQuery = useMemo(
    () => ({
      ...folderQuery,
      sort: sortSpec.key,
      direction: sortSpec.direction,
      page: peoplePage,
      limit: PEOPLE_PAGE_SIZE,
    }),
    [folderQuery, sortSpec.key, sortSpec.direction, peoplePage],
  );
  // "Select all N": the selection is every row matching folderQuery.
  const [allMatching, setAllMatching] = useState(false);
  useEffect(() => setAllMatching(false), [folderQuery]);

  // Fetch the people list at the InboxPage level so both Table view
  // (PeopleTable) and List view (PersonList sidebar) see the same data.
  // Previously the fetch lived inside PersonList, which meant Table view
  // showed an empty state because PersonList wasn't mounted.
  // Bumped to force a refetch of the current query (e.g. a WebMCP action just
  // saved a draft / enrolled a contact and we're already on that filter, so
  // the query params didn't change on their own).
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => onInboxRefresh(() => setRefreshNonce((n) => n + 1)), []);

  useEffect(() => {
    setPeopleLoading(true);
    const t = setTimeout(() => {
      fetchGroupedPeople(peopleQuery)
        .then((res) => {
          setItems(res.data);
          setPeopleTotal(res.total);
          setAggregates(res.aggregates);
        })
        .finally(() => setPeopleLoading(false));
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peopleQuery, refreshNonce]);

  // Manual refresh: re-fetch the current page immediately (no debounce) while
  // keeping the existing rows on screen. Returns the promise so the mobile
  // pull-to-refresh spinner can wait on it.
  const refreshPeople = useCallback(() => {
    setRefreshing(true);
    return fetchGroupedPeople(peopleQuery)
      .then((res) => {
        setItems(res.data);
        setPeopleTotal(res.total);
        setAggregates(res.aggregates);
      })
      .finally(() => setRefreshing(false));
  }, [peopleQuery]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectedConversation = useCallback((id: string) => {
    setSelectedConversationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Bulk-select all (or none) on the current page — covers BOTH person
  // and group rows in one shot. The header checkbox is "on" only when
  // every visible row is selected.
  const toggleSelectAll = useCallback(() => {
    const persons = items.filter(
      (it): it is GroupedPerson => it.type === "person",
    );
    const groups = items.filter(
      (it): it is GroupedConversation => it.type === "group",
    );
    const allPersonsSelected =
      persons.length === 0 || persons.every((p) => selectedIds.has(p.id));
    const allGroupsSelected =
      groups.length === 0 ||
      groups.every((g) => selectedConversationIds.has(g.id));
    const allOn = allPersonsSelected && allGroupsSelected;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allOn) {
        for (const p of persons) next.delete(p.id);
      } else {
        for (const p of persons) next.add(p.id);
      }
      return next;
    });
    setSelectedConversationIds((prev) => {
      const next = new Set(prev);
      if (allOn) {
        for (const g of groups) next.delete(g.id);
      } else {
        for (const g of groups) next.add(g.id);
      }
      return next;
    });
  }, [items, selectedIds, selectedConversationIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedConversationIds(new Set());
    setAllMatching(false);
  }, []);

  // Optimistic mark-read: clear unread locally on the matching rows,
  // fire APIs in parallel, roll back on failure.
  async function applyMarkRead(personIds: string[], conversationIds: string[]) {
    if (personIds.length === 0 && conversationIds.length === 0) return;
    setBulkBusy(true);
    const before = items;
    setItems(
      items.map((it) => {
        if (it.type === "person" && personIds.includes(it.id)) {
          return { ...it, unreadCount: 0 };
        }
        if (it.type === "group" && conversationIds.includes(it.id)) {
          return { ...it, unreadCount: 0 };
        }
        return it;
      }),
    );
    try {
      await Promise.all([
        personIds.length > 0
          ? markPeopleRead(personIds)
          : Promise.resolve(undefined),
        conversationIds.length > 0
          ? markConversationsRead(conversationIds)
          : Promise.resolve(undefined),
      ]);
      incrementRefreshKey();
      refreshMailCounts();
    } catch {
      setItems(before);
    } finally {
      setBulkBusy(false);
    }
  }

  // ── Star / pin / archive / snooze ──────────────────────────────────
  // Optimistic: the list changes at once, the server catches up, and a
  // failure puts the rows back. Archive and snooze take rows out of the
  // inbox, with an Undo toast.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  /** Does a row still belong in the current folder after this change? */
  function stillBelongs(it: GroupedItem, patch: StatePatch): boolean {
    const trashed =
      patch.trashed !== undefined ? patch.trashed : !!it.trashedAt;
    // Trash hides a row from every view but Trash itself.
    if (queryFolder === "trash") return trashed;
    if (trashed) return false;
    if (queryFolder === "all" || queryFolder === "sent") return true;
    const archived =
      patch.archived !== undefined ? patch.archived : !!it.archivedAt;
    const snoozed =
      patch.snoozedUntil !== undefined
        ? !!patch.snoozedUntil
        : !!it.snoozedUntil;
    const starred = patch.starred !== undefined ? patch.starred : it.starred;
    if (queryFolder === "inbox") return !archived && !snoozed;
    if (queryFolder === "archive") return archived;
    if (queryFolder === "snoozed") return snoozed;
    if (queryFolder === "starred") return starred;
    return true;
  }

  const changeMailState = useCallback(
    async (
      targets: GroupedItem[],
      patch: StatePatch,
      opts: { message?: string; undo?: StatePatch } = {},
    ) => {
      if (targets.length === 0) return;
      const keys = new Set(targets.map((t) => `${t.type}:${t.id}`));
      const before = itemsRef.current;
      const nowSec = Math.floor(Date.now() / 1000);
      const apply = (it: GroupedItem): GroupedItem => ({
        ...it,
        ...(patch.starred !== undefined ? { starred: patch.starred } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...(patch.archived !== undefined
          ? { archivedAt: patch.archived ? nowSec : null }
          : {}),
        ...(patch.snoozedUntil !== undefined
          ? { snoozedUntil: patch.snoozedUntil }
          : {}),
        ...(patch.trashed !== undefined
          ? { trashedAt: patch.trashed ? nowSec : null }
          : {}),
      });
      const removed = targets.filter((t) => !stillBelongs(t, patch));
      const removedKeys = new Set(removed.map((t) => `${t.type}:${t.id}`));
      setItems(
        before
          .filter((it) => !removedKeys.has(`${it.type}:${it.id}`))
          .map((it) => (keys.has(`${it.type}:${it.id}`) ? apply(it) : it)),
      );
      if (removed.length > 0) {
        setPeopleTotal((t) => Math.max(0, t - removed.length));
        // The row that takes the removed row's place: the next one down,
        // else the one above. Used to keep triage moving.
        const neighbour = (k: string | null) => {
          if (!k || !removedKeys.has(k)) return undefined;
          const i = before.findIndex((it) => keyOf(it) === k);
          const stays = (it: GroupedItem) => !removedKeys.has(keyOf(it));
          return (
            before.slice(i + 1).find(stays) ??
            before.slice(0, Math.max(0, i)).reverse().find(stays) ??
            null
          );
        };
        const openK = selectedPerson
          ? `person:${selectedPerson.id}`
          : selectedConversation
            ? `group:${selectedConversation.id}`
            : null;
        const nextOpen = neighbour(openK);
        if (nextOpen !== undefined) {
          // Desktop: open the next conversation (the list stays in view).
          // Phone: go back to the list, where the user can see what's left.
          if (nextOpen && !isNarrow) openRow(nextOpen);
          else {
            setSelectedPerson(null);
            setSelectedConversation(null);
          }
          if (nextOpen) setCursorKey(keyOf(nextOpen));
        } else {
          const nextCursor = neighbour(cursorKeyRef.current);
          if (nextCursor !== undefined)
            setCursorKey(nextCursor ? keyOf(nextCursor) : null);
        }
      } else {
        // Keep an open thread's header in step with the row.
        if (selectedPerson && keys.has(`person:${selectedPerson.id}`))
          setSelectedPerson(apply(selectedPerson) as GroupedPerson);
        if (
          selectedConversation &&
          keys.has(`group:${selectedConversation.id}`)
        )
          setSelectedConversation(
            apply(selectedConversation) as GroupedConversation,
          );
      }
      const refs = targets.map(itemRef);
      try {
        await updateMailState(refs, patch);
        refreshMailCounts();
        // Pinned rows sort first in the inbox: refetch to reorder.
        if (patch.pinned !== undefined) refreshPeople();
        const undo = opts.undo;
        const runUndo = undo
          ? () => {
              lastUndoRef.current = null;
              updateMailState(refs, undo)
                .then(() => {
                  refreshPeople();
                  refreshMailCounts();
                })
                .catch(() =>
                  showToast({ kind: "error", message: "Couldn't undo" }),
                );
            }
          : null;
        // "z" undoes the most recent change, toast or not.
        lastUndoRef.current = runUndo;
        if (opts.message) {
          showToast({
            kind: "success",
            message: opts.message,
            action: runUndo
              ? {
                  label: "Undo",
                  onClick: (dismiss) => {
                    dismiss();
                    runUndo();
                  },
                }
              : undefined,
          });
        }
      } catch {
        setItems(before);
        showToast({
          kind: "error",
          message: "Couldn't update the conversation",
          description: "Check your connection and try again.",
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryFolder, selectedPerson, selectedConversation, isNarrow],
  );

  const plural = (n: number, one: string) =>
    n === 1 ? `${one}` : `${n} conversations`;

  /** Move rows to Trash (hidden everywhere else), with Undo. */
  function trashMany(list: GroupedItem[]) {
    if (list.length === 0) return;
    changeMailState(
      list,
      { trashed: true },
      {
        message:
          list.length === 1
            ? "Moved to Trash"
            : `${list.length} conversations moved to Trash`,
        undo: { trashed: false },
      },
    );
    clearSelection();
  }

  function restoreMany(list: GroupedItem[]) {
    if (list.length === 0) return;
    changeMailState(
      list,
      { trashed: false },
      {
        message:
          list.length === 1
            ? "Restored from Trash"
            : `${list.length} conversations restored`,
        undo: { trashed: true },
      },
    );
    clearSelection();
  }

  /**
   * Delete forever: people only (a group conversation can't be
   * hard-deleted). Removes the person and all their mail for everyone, so
   * it asks first. Admins only; offered only inside Trash.
   */
  async function deleteForever(list: GroupedItem[]) {
    const people = list.filter(
      (it): it is GroupedPerson => it.type === "person",
    );
    const groups = list.length - people.length;
    if (people.length === 0) {
      showToast({
        kind: "info",
        message: "Group conversations can't be deleted forever",
        description: "Restore them, or leave them in Trash.",
      });
      return;
    }
    const who =
      people.length === 1
        ? `${people[0].name || people[0].email} and all ${people[0].totalCount} email${people[0].totalCount !== 1 ? "s" : ""}`
        : `${people.length} people and all their emails`;
    if (
      !confirm(
        `Delete ${who} forever? This removes them for everyone on this workspace and cannot be undone.${groups > 0 ? ` ${groups} group conversation${groups !== 1 ? "s" : ""} in the selection will stay in Trash.` : ""}`,
      )
    )
      return;
    setBulkBusy(true);
    const gone = new Set<string>();
    try {
      for (const p of people) {
        try {
          await deletePerson(p.id);
          gone.add(p.id);
        } catch {
          /* counted below */
        }
      }
    } finally {
      setBulkBusy(false);
    }
    setItems((prev) =>
      prev.filter((it) => !(it.type === "person" && gone.has(it.id))),
    );
    setPeopleTotal((t) => Math.max(0, t - gone.size));
    if (selectedPerson && gone.has(selectedPerson.id)) setSelectedPerson(null);
    clearSelection();
    refreshMailCounts();
    const failed = people.length - gone.size;
    showToast({
      kind: failed > 0 ? "error" : "success",
      message:
        gone.size === 1
          ? "Deleted forever"
          : `${gone.size} people deleted forever`,
      description:
        failed > 0
          ? `${failed} couldn't be deleted. Try again.`
          : groups > 0
            ? "Group conversations can't be deleted forever; they stay in Trash."
            : undefined,
    });
  }

  /** "Move to Primary / Promotions / …": a per-user correction by sender. */
  async function moveToCategory(it: GroupedPerson, to: MailCategory) {
    const sender = it.email.toLowerCase();
    try {
      await setCategoryOverride([sender], to);
      setItems((prev) =>
        prev.map((x) =>
          x.type === "person" && x.email.toLowerCase() === sender
            ? { ...x, category: to }
            : x,
        ),
      );
      if (filters.category && filters.category !== to) refreshPeople();
      showToast({
        kind: "success",
        message: `${it.name || it.email} now goes to ${CATEGORY_LABELS[to]}`,
        description: "Applies to all their mail, for you only.",
        action: {
          label: "Undo",
          onClick: (dismiss) => {
            dismiss();
            setCategoryOverride([sender], null)
              .then(() => refreshPeople())
              .catch(() =>
                showToast({ kind: "error", message: "Couldn't undo" }),
              );
          },
        },
      });
    } catch {
      showToast({ kind: "error", message: "Couldn't move this sender" });
    }
  }

  const inTrash = queryFolder === "trash";
  const mailActionsFor = (it: GroupedItem): MailActionHandlers =>
    inTrash
      ? {
          onRestore: () => restoreMany([it]),
          onToggleStar: () =>
            changeMailState(
              [it],
              { starred: !it.starred },
              { undo: { starred: it.starred } },
            ),
          ...(isAdmin && it.type === "person"
            ? { onDelete: () => deleteForever([it]) }
            : {}),
        }
      : {
          onToggleStar: () =>
            changeMailState(
              [it],
              { starred: !it.starred },
              { undo: { starred: it.starred } },
            ),
          onTogglePin: () =>
            changeMailState(
              [it],
              { pinned: !it.pinned },
              { undo: { pinned: it.pinned } },
            ),
          onArchive: () =>
            it.archivedAt
              ? changeMailState(
                  [it],
                  { archived: false },
                  {
                    message: "Moved to inbox",
                    undo: { archived: true },
                  },
                )
              : changeMailState(
                  [it],
                  { archived: true },
                  {
                    message: "Conversation archived",
                    undo: { archived: false },
                  },
                ),
          onSnooze: (until) =>
            changeMailState(
              [it],
              { snoozedUntil: until },
              until
                ? {
                    message: `Snoozed until ${new Date(until * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
                    undo: { snoozedUntil: it.snoozedUntil ?? null },
                  }
                : { message: "Back in your inbox" },
            ),
          onTrash: () => trashMany([it]),
          ...(it.type === "person"
            ? { onMoveToCategory: (c: MailCategory) => moveToCategory(it, c) }
            : {}),
        };

  const selectedItems = useMemo(
    () =>
      items.filter((it) =>
        it.type === "person"
          ? selectedIds.has(it.id)
          : selectedConversationIds.has(it.id),
      ),
    [items, selectedIds, selectedConversationIds],
  );

  /**
   * "Select all N" is on: apply the change to every row matching the
   * folder + filters on the server, then refetch. Returns false when the
   * selection is just the checked rows.
   */
  function applyToAllMatching(
    patch: StatePatch,
    opts: { message: (n: number) => string; undo?: StatePatch },
  ): boolean {
    if (!allMatching) return false;
    setBulkBusy(true);
    applyToFolder(folderQuery, patch)
      .then((refs: MailItemRef[]) => {
        clearSelection();
        refreshPeople();
        refreshMailCounts();
        const undo = opts.undo;
        const runUndo = undo
          ? () => {
              lastUndoRef.current = null;
              applyToRefs(refs, undo)
                .then(() => {
                  refreshPeople();
                  refreshMailCounts();
                })
                .catch(() =>
                  showToast({ kind: "error", message: "Couldn't undo" }),
                );
            }
          : null;
        lastUndoRef.current = runUndo;
        showToast({
          kind: "success",
          message: opts.message(refs.length),
          action: runUndo
            ? {
                label: "Undo",
                onClick: (dismiss) => {
                  dismiss();
                  runUndo();
                },
              }
            : undefined,
        });
      })
      .catch(() =>
        showToast({
          kind: "error",
          message: "Couldn't update the conversations",
          description: "Check your connection and try again.",
        }),
      )
      .finally(() => setBulkBusy(false));
    return true;
  }

  function handleBulkArchive() {
    const unarchive = folder === "archive";
    if (
      applyToAllMatching(
        { archived: !unarchive },
        {
          message: (n) =>
            `${plural(n, "Conversation")} ${unarchive ? "moved to inbox" : "archived"}`,
          undo: { archived: unarchive },
        },
      )
    )
      return;
    archiveMany(selectedItems);
  }

  function handleBulkTrash() {
    if (
      applyToAllMatching(
        { trashed: true },
        {
          message: (n) => `${plural(n, "Conversation")} moved to Trash`,
          undo: { trashed: false },
        },
      )
    )
      return;
    trashMany(selectedItems);
  }

  function handleBulkRestore() {
    if (
      applyToAllMatching(
        { trashed: false },
        {
          message: (n) => `${plural(n, "Conversation")} restored`,
          undo: { trashed: true },
        },
      )
    )
      return;
    restoreMany(selectedItems);
  }

  function handleBulkDeleteForever() {
    if (allMatching) void emptyTrash(folderQuery);
    else void deleteForever(selectedItems);
  }

  // ── Whole-folder actions ─────────────────────────────────────────────
  const [markingAll, setMarkingAll] = useState(false);

  /** "Mark all as read": every unread row in this folder + filters. */
  async function handleMarkFolderRead() {
    const n = aggregates.unreadRowCount;
    if (n === 0) return;
    if (
      n > PEOPLE_PAGE_SIZE &&
      !confirm(
        `Mark all ${n.toLocaleString()} unread conversations in ${viewLabel} as read?`,
      )
    )
      return;
    setMarkingAll(true);
    try {
      const done = await markFolderRead(folderQuery);
      setItems((prev) => prev.map((it) => ({ ...it, unreadCount: 0 })));
      refreshPeople();
      refreshMailCounts();
      incrementRefreshKey();
      showToast({
        kind: "success",
        message:
          done === 1
            ? "1 conversation marked as read"
            : `${done.toLocaleString()} conversations marked as read`,
      });
    } catch {
      showToast({ kind: "error", message: "Couldn't mark as read" });
    } finally {
      setMarkingAll(false);
    }
  }

  /**
   * Empty Trash (or "Delete forever" on "Select all N" in Trash): delete
   * every person in Trash forever. Group conversations can't be
   * hard-deleted, so they stay (restore-only) and the toast says so.
   */
  async function emptyTrash(
    query: Parameters<typeof deleteFolderForever>[0] = { folder: "trash" },
  ) {
    if (
      !confirm(
        "Delete every person in Trash forever? This removes them and all their mail for everyone on this workspace, and cannot be undone. Group conversations can't be deleted forever; they stay in Trash.",
      )
    )
      return;
    setBulkBusy(true);
    try {
      const res = await deleteFolderForever(query, deletePerson);
      setSelectedPerson(null);
      setSelectedConversation(null);
      clearSelection();
      await refreshPeople();
      refreshMailCounts();
      const notes: string[] = [];
      if (res.failed > 0) notes.push(`${res.failed} couldn't be deleted.`);
      if (res.skippedGroups > 0)
        notes.push(
          `${res.skippedGroups} group conversation${res.skippedGroups !== 1 ? "s" : ""} can't be deleted forever and stay${res.skippedGroups === 1 ? "s" : ""} in Trash.`,
        );
      showToast({
        kind: res.failed > 0 ? "error" : "success",
        message:
          res.deleted === 1
            ? "1 person deleted forever"
            : `${res.deleted.toLocaleString()} people deleted forever`,
        description: notes.join(" ") || undefined,
        durationMs: notes.length ? 7000 : undefined,
      });
    } catch {
      showToast({ kind: "error", message: "Couldn't empty Trash" });
    } finally {
      setBulkBusy(false);
    }
  }

  function archiveMany(list: GroupedItem[]) {
    const n = list.length;
    if (folder === "archive") {
      changeMailState(
        list,
        { archived: false },
        {
          message: `${plural(n, "Conversation")} moved to inbox`,
          undo: { archived: true },
        },
      );
    } else {
      changeMailState(
        list,
        { archived: true },
        {
          message: `${plural(n, "Conversation")} archived`,
          undo: { archived: false },
        },
      );
    }
    clearSelection();
  }

  function handleBulkSnooze(until: number | null) {
    if (
      applyToAllMatching(
        { snoozedUntil: until },
        {
          message: (n) =>
            until
              ? `${plural(n, "Conversation")} snoozed`
              : `${plural(n, "Conversation")} back in your inbox`,
          undo: until ? { snoozedUntil: null } : undefined,
        },
      )
    )
      return;
    snoozeMany(selectedItems, until);
  }

  function snoozeMany(list: GroupedItem[], until: number | null) {
    const n = list.length;
    changeMailState(
      list,
      { snoozedUntil: until },
      until
        ? {
            message: `${plural(n, "Conversation")} snoozed`,
            undo: { snoozedUntil: null },
          }
        : undefined,
    );
    clearSelection();
  }

  function handleBulkStar() {
    if (
      applyToAllMatching(
        { starred: true },
        {
          message: (n) => `${plural(n, "Conversation")} starred`,
          undo: { starred: false },
        },
      )
    )
      return;
    const allStarred = selectedItems.every((it) => it.starred);
    changeMailState(selectedItems, { starred: !allStarred });
    clearSelection();
  }

  function handleMarkPersonRead(id: string) {
    applyMarkRead([id], []);
  }

  function handleMarkConversationRead(id: string) {
    applyMarkRead([], [id]);
  }

  function handleBulkMarkRead() {
    if (allMatching) {
      void handleMarkFolderRead().then(clearSelection);
      return;
    }
    applyMarkRead(Array.from(selectedIds), Array.from(selectedConversationIds));
    clearSelection();
  }

  const handleBlockSelected = useCallback(async () => {
    const emails = items
      .filter((it) => it.type === "person" && selectedIds.has(it.id))
      .map((it) => (it as GroupedPerson).email.toLowerCase());
    if (emails.length === 0) return;
    await Promise.all(
      emails.map((value) => addBlock({ type: "email", value }).catch(() => {})),
    );
    clearSelection();
    await refreshPeople();
  }, [items, selectedIds, clearSelection, refreshPeople]);

  const [refreshKey, setRefreshKey] = useState(0);
  const [showBanner, setShowBanner] = useState(false);
  // When the user arrives via a Web Push notification (URL shape:
  // /inbox/:inbox/:personId — see worker/src/do/notifications.ts and
  // the route in App.tsx), pre-select that person so the tab shows the
  // intended conversation rather than the empty default view.
  const { personId: routePersonId } = useParams<{
    inbox: string;
    personId: string;
  }>();
  const lastProcessedPersonId = useRef<string | null>(null);

  useEffect(() => {
    if (!routePersonId) return;
    if (lastProcessedPersonId.current === routePersonId) return;
    if (selectedPerson?.id === routePersonId) {
      lastProcessedPersonId.current = routePersonId;
      return;
    }
    lastProcessedPersonId.current = routePersonId;

    // Prefer a hit in the already-loaded list (cheaper, has full grouped
    // stats); fall back to fetching the person directly so we can still
    // open the conversation when it isn't on the current page.
    const found = items.find(
      (it): it is GroupedPerson =>
        it.type === "person" && it.id === routePersonId,
    );
    if (found) {
      setSelectedPerson(found);
      return;
    }
    let cancelled = false;
    fetchPerson(routePersonId)
      .then((p) => {
        if (cancelled) return;
        setSelectedPerson({
          ...EMPTY_MAIL_ROW_STATE,
          type: "person",
          id: p.id,
          email: p.email,
          name: p.name,
          lastEmailAt: p.lastEmailAt,
          unreadCount: p.unreadCount,
          totalCount: p.totalCount,
          // recipientCount/hasAttachment aren't returned by /api/people/:id;
          // the grouped list will overwrite this object with full stats once
          // it loads. PersonDetail only needs `id` to fetch emails.
          recipientCount: 1,
          recipients: [],
          hasAttachment: 0,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [routePersonId, items, selectedPerson?.id]);

  function handleEmailRead(personId: string) {
    setItems((prev) =>
      prev.map((it) =>
        it.type === "person" && it.id === personId
          ? { ...it, unreadCount: Math.max(0, it.unreadCount - 1) }
          : it,
      ),
    );
  }

  // The open thread's sender (or their whole domain) was just blocked, so it
  // no longer belongs in the inbox. Drop the selection back to "no mail
  // selected" and refresh the list so the hidden thread disappears.
  function handlePersonBlocked() {
    setSelectedPerson(null);
    refreshPeople();
  }

  function handleEmailDelete(personId: string, wasUnread: boolean) {
    setItems((prev) =>
      prev.map((it) =>
        it.type === "person" && it.id === personId
          ? {
              ...it,
              totalCount: Math.max(0, it.totalCount - 1),
              unreadCount: wasUnread
                ? Math.max(0, it.unreadCount - 1)
                : it.unreadCount,
            }
          : it,
      ),
    );
  }

  useEffect(() => {
    fetchStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  const incrementRefreshKey = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  function onShouldPromptPush() {
    if (!isPushSupported()) return;
    if (hasDismissedPrompt()) return;
    if (Notification.permission !== "default") return;
    setShowBanner(true);
  }

  useRealtimeUpdates(incrementRefreshKey, onShouldPromptPush);

  const internalDomains =
    stats?.senderIdentities?.map((st) => {
      const at = st.email.lastIndexOf("@");
      return at === -1 ? "" : st.email.slice(at + 1).toLowerCase();
    }) ?? [];
  const viewLabel = MAIL_VIEWS.find((v) => v.id === mailView)?.label ?? "Inbox";
  const selectionCount = selectedIds.size + selectedConversationIds.size;
  const openItem: GroupedItem | null = selectedPerson ?? selectedConversation;
  const openState: MailStateLike | undefined = openItem ?? undefined;
  const openActions = openItem ? mailActionsFor(openItem) : undefined;

  // ── Keyboard triage (default layout) ───────────────────────────────
  // The handler is rebuilt every render (it reads the latest list, the
  // open row and the selection); one document listener calls the latest.
  const openKey = openItem ? keyOf(openItem) : null;
  useEffect(() => {
    if (openKey) setCursorKey(openKey);
  }, [openKey]);

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (shouldIgnoreKey(e) || agentPlanOpen) return;
    // A pending "g" chord owns this key (PortalShell navigates with it).
    if (goChord.pending()) return;
    const shell = shellStore.get();
    if (shell.cmdk || shell.keys || snoozeTargets) return;

    const curIdx = items.findIndex(
      (it) => keyOf(it) === (openKey ?? cursorKey),
    );
    const cursorItem = curIdx >= 0 ? items[curIdx] : null;
    // What an action applies to: the open conversation, else the
    // checked rows, else the row under the cursor.
    const targets: GroupedItem[] = openItem
      ? [openItem]
      : selectedItems.length > 0
        ? selectedItems
        : cursorItem
          ? [cursorItem]
          : [];

    const move = (delta: number) => {
      if (items.length === 0) return;
      const next =
        curIdx === -1
          ? delta > 0
            ? 0
            : items.length - 1
          : Math.min(items.length - 1, Math.max(0, curIdx + delta));
      const it = items[next];
      setCursorKey(keyOf(it));
      if (openItem && view === "list") openRow(it);
      requestAnimationFrame(() => {
        const el = rowElement(keyOf(it));
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "nearest" });
      });
    };

    const k = e.key;
    let handled = true;
    // Table view has its own row layout: list shortcuts apply only to
    // the list (or to a conversation opened from either).
    if (view === "table" && !openItem && ["j", "k", "x", "o"].includes(k))
      return;
    if (k === "j" || k === "ArrowDown") move(1);
    else if (k === "k" || k === "ArrowUp") move(-1);
    else if ((k === "Enter" || k === "o") && cursorItem && !openItem) {
      // Enter on a focused row button already clicks it.
      if (k === "Enter" && document.activeElement?.closest("button")) return;
      openRow(cursorItem);
    } else if (k === "Escape" || k === "u") {
      if (openItem) {
        const key = keyOf(openItem);
        setSelectedPerson(null);
        setSelectedConversation(null);
        requestAnimationFrame(() => rowElement(key)?.focus());
      } else if (selectionCount > 0) clearSelection();
      else handled = false;
    } else if (k === "x" && cursorItem && !openItem) {
      if (cursorItem.type === "person") toggleSelected(cursorItem.id);
      else toggleSelectedConversation(cursorItem.id);
    } else if (k === "z") {
      if (lastUndoRef.current) {
        lastUndoRef.current();
        showToast({ kind: "info", message: "Undone" });
      } else showToast({ kind: "info", message: "Nothing to undo" });
    } else if (targets.length === 0) {
      handled = false;
    } else if (k === "#") {
      // Trash (with Undo). Inside Trash, admins delete forever (asks).
      if (!inTrash) trashMany(targets);
      else if (isAdmin) void deleteForever(targets);
      else handled = false;
    } else if (inTrash && ["e", "b", "p"].includes(k)) {
      // Archive / snooze / pin don't apply in Trash: restore first.
      handled = false;
    } else if (k === "e") {
      if (targets.length === 1) mailActionsFor(targets[0]).onArchive?.();
      else archiveMany(targets);
    } else if (k === "s") {
      if (targets.length === 1) mailActionsFor(targets[0]).onToggleStar?.();
      else {
        changeMailState(targets, {
          starred: !targets.every((it) => it.starred),
        });
        clearSelection();
      }
    } else if (k === "p" && targets.length === 1) {
      mailActionsFor(targets[0]).onTogglePin?.();
    } else if (k === "b") {
      setSnoozeTargets(targets);
    } else if (k === "I") {
      applyMarkRead(
        targets.filter((t) => t.type === "person").map((t) => t.id),
        targets.filter((t) => t.type === "group").map((t) => t.id),
      );
    } else if (k === "r" && targets.length === 1) {
      if (!openItem) openRow(targets[0]);
      focusReplyWhenReady();
    } else handled = false;
    if (handled) e.preventDefault();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyHandler.current(e);
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);

  if (stats && stats.recipients.length === 0 && !isAdmin) {
    return (
      <div className="pt-page flex flex-1 items-center justify-center">
        <div className="pt-card pt-empty max-w-md px-10 py-12">
          <span className="ic">
            <Mail size={18} />
          </span>
          <h2 className="text-base font-semibold text-text-primary">
            No inboxes assigned yet
          </h2>
          <p className="text-[13.5px]">
            Ask an admin to grant you access to an inbox.
          </p>
        </div>
      </div>
    );
  }

  const renderPerson = (onBack?: () => void) =>
    selectedPerson && (
      <PersonDetail
        onBack={onBack}
        person={selectedPerson}
        onEmailRead={handleEmailRead}
        onEmailDelete={handleEmailDelete}
        refreshKey={refreshKey}
        onOpenCompose={onCompose}
        onBlock={handlePersonBlocked}
        mailState={openState}
        mailActions={openActions}
      />
    );
  const renderConversation = (onBack?: () => void) =>
    selectedConversation && (
      <ConversationDetail
        onBack={onBack}
        conversation={selectedConversation}
        refreshKey={refreshKey}
        internalDomains={internalDomains}
        onOpenCompose={onCompose}
        mailState={openState}
        mailActions={openActions}
      />
    );

  // Every row on this page is checked, and more rows match: offer
  // "Select all N" (Gmail-style), which switches bulk actions to the
  // whole folder + filters on the server.
  const pageAllSelected =
    items.length > 0 &&
    items.every((it) =>
      it.type === "person"
        ? selectedIds.has(it.id)
        : selectedConversationIds.has(it.id),
    );
  const selectionBar = (
    <SelectionBar
      count={selectionCount}
      busy={bulkBusy}
      onMarkRead={handleBulkMarkRead}
      onBlock={allMatching || inTrash ? undefined : handleBlockSelected}
      onClear={clearSelection}
      onArchive={inTrash ? undefined : handleBulkArchive}
      archiveLabel={folder === "archive" ? "Move to inbox" : "Archive"}
      onSnooze={inTrash ? undefined : handleBulkSnooze}
      onStar={inTrash ? undefined : handleBulkStar}
      onTrash={inTrash ? undefined : handleBulkTrash}
      onRestore={inTrash ? handleBulkRestore : undefined}
      onDeleteForever={inTrash && isAdmin ? handleBulkDeleteForever : undefined}
      matchingTotal={peopleTotal}
      allMatching={allMatching}
      onSelectAllMatching={
        pageAllSelected && peopleTotal > items.length
          ? () => setAllMatching(true)
          : undefined
      }
    />
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col px-0 pb-0 pt-0 sm:px-5 sm:pb-5 sm:pt-4 lg:px-6"
      // Lets the shell hide the mobile Compose button while a thread (with
      // its own reply bar) is open — see .compose-fab in src/index.css.
      data-thread-open={selectedPerson || selectedConversation ? "" : undefined}
      data-selecting={selectionCount > 0 ? "" : undefined}
    >
      <SnoozeDialog
        open={!!snoozeTargets}
        onClose={() => setSnoozeTargets(null)}
        subject={
          snoozeTargets && snoozeTargets.length === 1
            ? snoozeTargets[0].type === "person"
              ? snoozeTargets[0].name || snoozeTargets[0].email
              : "This conversation"
            : `${snoozeTargets?.length ?? 0} conversations`
        }
        snoozed={!!snoozeTargets?.some((t) => t.snoozedUntil)}
        onPick={(until) => {
          const list = snoozeTargets ?? [];
          if (list.length === 1) mailActionsFor(list[0]).onSnooze?.(until);
          else snoozeMany(list, until);
        }}
      />
      {/* Header + filters. Hidden while a thread is open in table view, and
          on phones while a thread is open (the thread has its own header). */}
      {!(view === "table" && (selectedPerson || selectedConversation)) && (
        <div
          className={cn(
            "shrink-0 px-3.5 pb-3 pt-3 sm:px-0 sm:pt-0",
            (selectedPerson || selectedConversation) && "hidden sm:block",
          )}
        >
          <InboxToolbar
            title={viewLabel}
            count={peopleTotal}
            filters={filters}
            onFiltersChange={setFilters}
            inboxes={stats?.senderIdentities ?? []}
            search={search}
            onSearchChange={setSearch}
            view={view}
            onViewChange={(v) => {
              setView(v);
              setSelectedPerson(null);
              clearSelection();
              if (agentPlanOpen) toggleAgentPlan();
            }}
            sortSpec={sortSpec}
            onSortChange={setSortSpec}
            onRefresh={refreshPeople}
            refreshing={refreshing}
            onCompose={onCompose}
            agentPlanActive={agentPlanOpen}
            onAgentPlanToggle={toggleAgentPlan}
            onMarkAllRead={inTrash ? undefined : handleMarkFolderRead}
            unreadCount={aggregates.unreadRowCount}
            markAllReadBusy={markingAll}
          />
          {inTrash && !agentPlanOpen && (
            <div
              className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-bg-subtle px-3.5 py-2.5 text-[13px] text-text-secondary"
              data-testid="trash-notice"
            >
              <Trash2 size={14} className="shrink-0 text-text-tertiary" />
              <span className="min-w-0 flex-1">
                Conversations in Trash are hidden from your other folders, for
                you only. New mail brings one back.{" "}
                {isAdmin
                  ? "Delete forever removes a person and their mail for everyone; group conversations can only be restored."
                  : "Only admins can delete mail forever."}
              </span>
              {isAdmin && peopleTotal > 0 && (
                <button
                  type="button"
                  onClick={() => void emptyTrash()}
                  disabled={bulkBusy}
                  data-testid="empty-trash"
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border-strong bg-card px-3 text-[13px] font-medium text-destructive shadow-card transition-colors hover:bg-destructive-subtle disabled:opacity-50"
                >
                  {bulkBusy ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Trash2 size={13} />
                  )}
                  Empty Trash
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Selection bar — desktop: above the list. Mobile: floats at the
          bottom of the screen within thumb reach. */}
      {selectionCount > 0 && !selectedPerson && !selectedConversation && (
        <>
          <div className="mb-3 hidden shrink-0 sm:block">{selectionBar}</div>
          <div
            className="fixed inset-x-3 z-40 sm:hidden"
            style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          >
            {selectionBar}
          </div>
        </>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border bg-card sm:rounded-2xl sm:border sm:shadow-card">
        {agentPlanOpen ? (
          <AgentPlan />
        ) : view === "table" ? (
          selectedConversation ? (
            <div id="pt-reading" className="flex h-full min-h-0 flex-col">
              {renderConversation(() => setSelectedConversation(null))}
            </div>
          ) : selectedPerson ? (
            <div id="pt-reading" className="flex h-full min-h-0 flex-col">
              {renderPerson(() => setSelectedPerson(null))}
            </div>
          ) : (
            // `min-h-0 overflow-hidden` lets the inner ScrollArea constrain.
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <PeopleTable
                items={items}
                loading={peopleLoading}
                onSelectPerson={(p) => {
                  setSelectedConversation(null);
                  setSelectedPerson(p);
                }}
                onSelectConversation={(c) => {
                  setSelectedPerson(null);
                  setSelectedConversation(c);
                }}
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
                selectedConversationIds={selectedConversationIds}
                onToggleSelectedConversation={toggleSelectedConversation}
                onToggleSelectAll={toggleSelectAll}
                onMarkPersonRead={handleMarkPersonRead}
                onMarkConversationRead={handleMarkConversationRead}
                sortSpec={sortSpec}
                onSortChange={setSortSpec}
                total={peopleTotal}
                page={peoplePage}
                pageSize={PEOPLE_PAGE_SIZE}
                onPageChange={setPeoplePage}
                aggregates={aggregates}
                mailActions={mailActionsFor}
              />
            </div>
          )
        ) : (
          // List view — list + reading pane (or empty state).
          <div className="flex h-full min-h-0">
            <div
              className={cn(
                "relative shrink-0 border-r border-border bg-card",
                selectedPerson || selectedConversation
                  ? "hidden md:block"
                  : "block",
                "w-full md:w-auto",
              )}
              style={{
                width:
                  typeof window !== "undefined" && window.innerWidth >= 768
                    ? sidebarWidth
                    : undefined,
              }}
            >
              {showBanner && (
                <PushOptInBanner onClose={() => setShowBanner(false)} />
              )}
              <PersonList
                items={items}
                loading={peopleLoading}
                total={peopleTotal}
                pageSize={PEOPLE_PAGE_SIZE}
                page={peoplePage}
                onPageChange={setPeoplePage}
                selectedPersonId={selectedPerson?.id ?? null}
                selectedConversationId={selectedConversation?.id ?? null}
                onSelectPerson={(p) => {
                  setSelectedConversation(null);
                  setSelectedPerson(p);
                }}
                onSelectConversation={(c) => {
                  setSelectedPerson(null);
                  setSelectedConversation(c);
                }}
                isAdmin={isAdmin}
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
                onMarkPersonRead={handleMarkPersonRead}
                onMarkConversationRead={handleMarkConversationRead}
                onRefresh={refreshPeople}
                compact={isCompact}
                mailActions={mailActionsFor}
                emptyMessage={
                  search.trim() ? "No people found" : FOLDER_EMPTY[mailView]
                }
              />
              {/* Drag handle */}
              <div
                onMouseDown={startDrag}
                onTouchStart={startDrag}
                role="separator"
                aria-label="Resize sidebar"
                aria-orientation="vertical"
                className="group/handle absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize items-center justify-center md:flex"
              >
                <span className="h-full w-px bg-transparent transition-colors group-hover/handle:bg-accent/40" />
              </div>
            </div>

            <div
              id="pt-reading"
              className={cn(
                "min-w-0 flex-1 bg-bg-subtle",
                selectedPerson || selectedConversation
                  ? "block"
                  : "hidden md:block",
              )}
            >
              {selectedConversation ? (
                <div className="flex h-full flex-col">
                  <div className="flex-1 overflow-hidden">
                    {renderConversation(
                      isNarrow
                        ? () => setSelectedConversation(null)
                        : undefined,
                    )}
                  </div>
                </div>
              ) : selectedPerson ? (
                <div className="flex h-full flex-col">
                  <div className="flex-1 overflow-hidden">
                    {renderPerson(
                      isNarrow ? () => setSelectedPerson(null) : undefined,
                    )}
                  </div>
                </div>
              ) : (
                <div className="pt-empty h-full">
                  <span className="ic">
                    <Mail size={18} />
                  </span>
                  {aggregates.unreadRowCount > 0 && (
                    <p className="text-[15px] font-semibold text-text-primary">
                      {aggregates.unreadRowCount.toLocaleString()} unread{" "}
                      {aggregates.unreadRowCount === 1
                        ? "conversation"
                        : "conversations"}
                    </p>
                  )}
                  <p>
                    Select a person to view emails, or switch to Table view for
                    an overview.
                  </p>
                  <ul className="pt-empty-keys" aria-label="Shortcuts">
                    <li>
                      <kbd>j</kbd>
                      <kbd>k</kbd> move
                    </li>
                    <li>
                      <kbd>e</kbd> archive
                    </li>
                    <li>
                      <kbd>b</kbd> snooze
                    </li>
                    <li>
                      <kbd>r</kbd> reply
                    </li>
                    <li>
                      <kbd>c</kbd> new message
                    </li>
                  </ul>
                  <button
                    type="button"
                    className="text-[13px] font-medium text-accent-subtle-fg hover:underline"
                    onClick={() => shellStore.set({ keys: true })}
                  >
                    All keyboard shortcuts <kbd className="ml-1">?</kbd>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
