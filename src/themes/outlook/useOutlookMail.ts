import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  EMPTY_MAIL_ROW_STATE,
  addBlock,
  fetchConversationEmails,
  fetchGroupedPeople,
  fetchPerson,
  fetchPersonEmails,
  markEmailRead,
  updateMailState,
  type GroupedItem,
  type MailCategory,
  type MailFolder,
  setCategoryOverride,
} from "@/lib/api";
import { markFolderRead } from "@/lib/folder-actions";
import { emptyTrash } from "./folderOps";
import { REPLY_REOPEN_EVENT } from "./InlineReply";
import { usePreferences } from "@/lib/preferences";
import { useSession } from "@/lib/auth-client";
import { itemKey, itemRef, itemTitle } from "@/hooks/useMailList";
import { showToast } from "@/lib/toast";
import {
  FOLDER_LABELS,
  filterQuery,
  serverSort,
  type ArrangeBy,
  folderQuery,
  groupRows,
  parseFolder,
  parseSearchQuery,
  rangeKeys,
  sweepSelection,
  senderAddresses,
  type ListFilter,
  type ListSort,
  type OlFolderId,
} from "./lib";
import { folderHref, type FolderTarget } from "./FolderList";
import { useOutlook } from "./context";
import { useOutlookList, type StatePatch } from "./useOutlookList";

export type FocusTab = "focused" | "other";
export type MoveTarget =
  | "inbox"
  | "archive"
  | "deleted"
  | "snoozed"
  | "flagged";

function parseOpen(
  raw: string | null,
): { type: "person" | "group"; id: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(":");
  if (i < 0) return null;
  const type = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if ((type !== "person" && type !== "group") || !id) return null;
  return { type, id };
}

/** Snapshot of a row's mail state, so Undo restores exactly. */
interface Snapshot {
  item: GroupedItem;
  state: Required<StatePatch>;
}
function snapshot(items: GroupedItem[]): Snapshot[] {
  return items.map((item) => ({
    item,
    state: {
      starred: item.starred,
      pinned: item.pinned,
      archived: !!item.archivedAt,
      snoozedUntil: item.snoozedUntil,
      trashed: !!item.trashedAt,
    },
  }));
}

/**
 * Everything the Outlook mail module needs, desktop and mobile: folder and
 * search state from the URL (with Outlook query syntax), the list with
 * filters / arrange-by / Focused-Other, selection (the keyboard cursor
 * counts as selected), and mail actions with a multi-step Undo.
 */
export function useOutlookMail() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const routeParams = useParams<{ inbox?: string; personId?: string }>();
  const o = useOutlook();
  // Permanent delete (DELETE /api/people/:id) is admin-only on the server:
  // it removes the person and their mail for the whole team.
  const { data: session } = useSession();
  const canDeleteForever = session?.user?.role === "admin";

  const urlFolder: OlFolderId = parseFolder(params.get("folder"));
  const label = params.get("label") || undefined;
  const q = params.get("q") || "";
  const scopeCurrent = params.get("scope") === "current";
  const popout = params.get("popout") === "1";
  const parsed = useMemo(() => parseSearchQuery(q), [q]);
  const folder: OlFolderId = q && parsed.folder ? parsed.folder : urlFolder;

  const openParam =
    parseOpen(params.get("open")) ??
    (routeParams.personId
      ? { type: "person" as const, id: routeParams.personId }
      : null);
  const openKey = openParam ? `${openParam.type}:${openParam.id}` : null;

  const [filter, setFilterState] = useState<ListFilter>("all");
  const setFilter = (f: ListFilter) => setFilterState(f);
  // Arrange by is an account setting (server-side sort).
  const sort: ArrangeBy = o.sort;
  const setSort = (s: ArrangeBy) => o.setLayout({ sort: s });
  const [focusTab, setFocusTabState] = useState<FocusTab>("focused");
  const { setPreferences } = usePreferences();
  const setFocusTab = (t: FocusTab) => {
    setFocusTabState(t);
    // Opening Other clears its "new" count (tabCounts.new).
    if (t === "other") {
      const now = Math.floor(Date.now() / 1000);
      void setPreferences({
        tabSeen: { promotions: now, social: now, updates: now },
      });
    }
  };

  // ── Server query (every filter, date and sort runs on the server) ─────
  const recipientFromTo =
    parsed.to && o.knownInboxes.includes(parsed.to.toLowerCase())
      ? parsed.to.toLowerCase()
      : undefined;
  // A to: that isn't one of the team's inboxes can't be a recipient
  // filter; search for it as text rather than silently dropping it.
  const toAsText = parsed.to && !recipientFromTo ? parsed.to : undefined;
  const searchText =
    [parsed.text, toAsText].filter(Boolean).join(" ") || undefined;
  const showFocusTabs = o.focusedInbox && folder === "inbox" && !label && !q;
  const query = useMemo(() => {
    const searching = !!q;
    const fq = folderQuery(folder);
    const base: {
      folder: MailFolder;
      drafts?: boolean;
      sequenced?: boolean;
      unread?: boolean;
    } = searching && !scopeCurrent && !parsed.folder ? { folder: "all" } : fq;
    const f = filterQuery(filter);
    return {
      ...base,
      recipient: recipientFromTo ?? label,
      q: searchText,
      unread: base.unread || f.unread || parsed.unread || undefined,
      hasAttachment: f.hasAttachment || parsed.hasAttachment || undefined,
      starred: f.starred || parsed.flagged || undefined,
      pinned: f.pinned,
      from: parsed.from || undefined,
      subject: parsed.subject || undefined,
      after: parsed.after,
      before: parsed.before,
      sort: serverSort(sort),
      categories: showFocusTabs
        ? focusTab === "focused"
          ? (["primary"] as MailCategory[])
          : (["promotions", "social", "updates"] as MailCategory[])
        : undefined,
      withTabCounts: showFocusTabs || undefined,
    };
  }, [
    folder,
    label,
    q,
    scopeCurrent,
    parsed,
    filter,
    recipientFromTo,
    searchText,
    sort,
    showFocusTabs,
    focusTab,
  ]);

  const list = useOutlookList(query);

  // Focused / Other counts come from the server (withTabCounts).
  const tc = list.tabCounts;
  const otherUnreadCount = tc
    ? tc.promotions.unread + tc.social.unread + tc.updates.unread
    : 0;
  const otherNewCount = tc
    ? tc.promotions.new + tc.social.new + tc.updates.new
    : 0;
  const visible = list.items;
  const filtered = visible;

  const groups = useMemo(
    () =>
      groupRows(
        visible,
        sort as ListSort,
        itemTitle,
        new Date(),
        folder === "inbox" && !q && sort === "date",
      ),
    [visible, sort, folder, q],
  );
  const order = useMemo(
    () => groups.flatMap((g) => g.items.map(itemKey)),
    [groups],
  );

  // ── Selection ─────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(openKey ? [openKey] : []),
  );
  const [cursorKey, setCursorKey] = useState<string | null>(openKey);
  const [checkMode, setCheckMode] = useState(false);
  const anchorRef = useRef<string | null>(openKey);

  useEffect(() => {
    if (openKey) {
      setSelected(new Set([openKey]));
      setCursorKey(openKey);
      anchorRef.current = openKey;
    }
  }, [openKey]);

  useEffect(() => {
    setSelected(new Set());
    setCheckMode(false);
    setCursorKey(null);
  }, [folder, label, q, focusTab]);

  const byKey = useMemo(() => {
    const m = new Map<string, GroupedItem>();
    for (const it of list.items) m.set(itemKey(it), it);
    return m;
  }, [list.items]);

  // Opened row that is not in the loaded list (deep link, search pick).
  const [fallback, setFallback] = useState<GroupedItem | null>(null);
  useEffect(() => {
    if (!openParam || byKey.has(openKey!)) return;
    if (fallback && itemKey(fallback) === openKey) return;
    let cancelled = false;
    if (openParam.type === "person") {
      fetchPerson(openParam.id)
        .then((p) => {
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
            recipients: [],
            hasAttachment: 0,
            latestSubject: p.latestSubject ?? null,
          });
        })
        .catch(() => {});
    } else {
      fetchConversationEmails(openParam.id)
        .then((c) => {
          if (cancelled) return;
          const last = c.emails[c.emails.length - 1];
          setFallback({
            ...EMPTY_MAIL_ROW_STATE,
            type: "group",
            id: c.conversation.id,
            inbox: c.conversation.inbox,
            participants: c.conversation.participants,
            ccParticipants: [],
            lastEmailAt: last?.timestamp ?? 0,
            unreadCount: 0,
            totalCount: c.emails.length,
            hasAttachment: 0,
            latestSubject: last?.subject ?? null,
          });
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, byKey]);

  const openedItem: GroupedItem | null = openKey
    ? (byKey.get(openKey) ??
      (fallback && itemKey(fallback) === openKey ? fallback : null))
    : null;

  const selectedItems = useMemo(
    () =>
      [...selected]
        .map(
          (k) =>
            byKey.get(k) ??
            (openedItem && itemKey(openedItem) === k ? openedItem : null),
        )
        .filter((x): x is GroupedItem => !!x),
    [selected, byKey, openedItem],
  );
  const cursorItem = cursorKey ? (byKey.get(cursorKey) ?? null) : null;
  /** Rows a command applies to: selection, else the open row, else the
   *  keyboard-focused row (Outlook treats the focused row as selected). */
  const targets: GroupedItem[] =
    selectedItems.length > 0
      ? selectedItems
      : openedItem
        ? [openedItem]
        : cursorItem
          ? [cursorItem]
          : [];

  const setOpen = useCallback(
    (key: string | null, replace = false) => {
      const next = new URLSearchParams(params);
      if (key) next.set("open", key);
      else next.delete("open");
      if (routeParams.personId) navigate(`/?${next.toString()}`, { replace });
      else setParams(next, { replace });
    },
    [params, setParams, navigate, routeParams.personId],
  );

  // Undo send on a reply reopens that conversation if the user moved on.
  useEffect(() => {
    const on = (e: Event) => {
      const key = (e as CustomEvent<string>).detail;
      if (key && key !== openKey) setOpen(key);
    };
    window.addEventListener(REPLY_REOPEN_EVENT, on);
    return () => window.removeEventListener(REPLY_REOPEN_EVENT, on);
  }, [openKey, setOpen]);

  // Outlook opens the top conversation when a folder loads, so the reading
  // pane and ribbon are live. It is not marked read until the user acts.
  const [autoKey, setAutoKey] = useState<string | null>(null);
  const autoDoneFor = useRef("");
  const viewKey = `${folder}|${label ?? ""}|${q}|${focusTab}`;
  useEffect(() => {
    if (o.isMobile || popout || o.readingPane === "off" || o.compose) return;
    if (openKey || selected.size > 0) {
      autoDoneFor.current = viewKey;
      return;
    }
    if (list.loading || order.length === 0) return;
    if (autoDoneFor.current === viewKey) return;
    autoDoneFor.current = viewKey;
    setAutoKey(order[0]);
    setCursorKey(order[0]);
    setOpen(order[0], true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, list.loading, order, openKey, o.isMobile, o.readingPane]);

  const openItem = useCallback(
    (item: GroupedItem | null, opts?: { replace?: boolean }) => {
      setAutoKey(null);
      if (item) o.closeCompose();
      setOpen(item ? itemKey(item) : null, opts?.replace);
      if (!item) setSelected(new Set());
    },
    [setOpen, o],
  );

  const clickRow = useCallback(
    (
      item: GroupedItem,
      e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
    ) => {
      const key = itemKey(item);
      setCursorKey(key);
      setAutoKey(null);
      if (e.shiftKey && anchorRef.current) {
        const keys = rangeKeys(order, anchorRef.current, key);
        setSelected(new Set(keys));
        if (keys.length > 1) setOpen(null, true);
        return;
      }
      if (e.ctrlKey || e.metaKey || checkMode) {
        const next = new Set(selected);
        if (openKey && next.size === 0) next.add(openKey);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        anchorRef.current = key;
        setSelected(next);
        if (next.size === 1 && !checkMode) setOpen([...next][0], true);
        else if (openKey) setOpen(null, true);
        return;
      }
      anchorRef.current = key;
      openItem(item);
    },
    [order, selected, checkMode, setOpen, openItem, openKey],
  );

  const toggleChecked = useCallback(
    (item: GroupedItem) => {
      const key = itemKey(item);
      const next = new Set(selected);
      if (openKey && next.size === 0) next.add(openKey);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      anchorRef.current = key;
      setCursorKey(key);
      setSelected(next);
      if (openKey) setOpen(null, true);
    },
    [selected, openKey, setOpen],
  );

  /** Right-click / drag: keep a multi-selection that contains the row. */
  const actionRows = useCallback(
    (item: GroupedItem): GroupedItem[] => {
      const key = itemKey(item);
      if (selected.has(key) && selectedItems.length > 1) return selectedItems;
      return [item];
    },
    [selected, selectedItems],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(order));
    if (openKey) setOpen(null, true);
  }, [order, openKey, setOpen]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setCheckMode(false);
    if (openKey) setOpen(null);
  }, [openKey, setOpen]);

  /** Move the open row (or cursor) through the list and open it. */
  const stepTo = useCallback(
    (where: 1 | -1 | "first" | "last") => {
      if (order.length === 0) return;
      const cur = openKey ?? cursorKey ?? [...selected][0] ?? null;
      const i = cur ? order.indexOf(cur) : -1;
      const j =
        where === "first"
          ? 0
          : where === "last"
            ? order.length - 1
            : i < 0
              ? 0
              : Math.max(0, Math.min(order.length - 1, i + where));
      const it = byKey.get(order[j]);
      if (it) {
        setCursorKey(order[j]);
        openItem(it, { replace: true });
      }
    },
    [order, openKey, cursorKey, selected, byKey, openItem],
  );

  /** After rows leave the view, open the neighbour (Outlook default). */
  const openNeighbour = useCallback(
    (gone: GroupedItem[]) => {
      const goneKeys = new Set(gone.map(itemKey));
      setSelected((s) => new Set([...s].filter((k) => !goneKeys.has(k))));
      const cur = openKey ?? cursorKey;
      if (!cur || !goneKeys.has(cur)) return;
      const i = order.indexOf(cur);
      const rest = order.filter((k) => !goneKeys.has(k));
      const nextKey = rest[Math.min(i, rest.length - 1)] ?? null;
      setCursorKey(nextKey);
      if (openKey) {
        const it = nextKey ? byKey.get(nextKey) : null;
        openItem(o.isMobile ? null : (it ?? null), { replace: true });
      }
    },
    [openKey, cursorKey, order, byKey, openItem, o.isMobile],
  );

  // ── Undo stack ────────────────────────────────────────────────────────
  const [undoStack, setUndoStack] = useState<
    Array<{ label: string; snaps: Snapshot[] }>
  >([]);
  const pushUndo = (labelText: string, snaps: Snapshot[]) =>
    setUndoStack((s) => [...s.slice(-19), { label: labelText, snaps }]);

  const restore = useCallback(
    async (snaps: Snapshot[]) => {
      const byState = new Map<string, Snapshot[]>();
      for (const s of snaps) {
        const k = JSON.stringify(s.state);
        byState.set(k, [...(byState.get(k) ?? []), s]);
      }
      await Promise.all(
        [...byState.values()].map((g) =>
          updateMailState(
            g.map((s) => itemRef(s.item)),
            g[0].state,
          ),
        ),
      );
      list.refresh();
    },
    [list],
  );

  const undo = useCallback(async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) {
      showToast({ kind: "info", message: "Nothing to undo" });
      return;
    }
    setUndoStack((s) => s.slice(0, -1));
    try {
      await restore(last.snaps);
      showToast({ kind: "info", message: `Undone: ${last.label}` });
    } catch {
      showToast({ kind: "error", message: "Couldn't undo" });
    }
  }, [undoStack, restore]);

  // ── Actions ───────────────────────────────────────────────────────────
  const serverFolder = query.folder;
  const leaves = (patch: StatePatch): boolean => {
    // Deleted Items hides a row everywhere else; Restore takes it out of Trash.
    if (serverFolder === "trash") return patch.trashed === false;
    if (patch.trashed) return true;
    if (serverFolder === "inbox")
      return !!patch.archived || (patch.snoozedUntil ?? null) !== null;
    if (serverFolder === "archive") return patch.archived === false;
    if (serverFolder === "snoozed") return patch.snoozedUntil === null;
    if (serverFolder === "starred") return patch.starred === false;
    return false;
  };

  const change = (
    items: GroupedItem[],
    patch: StatePatch,
    labelText: string,
    toast?: string,
  ) => {
    if (!items.length) return;
    const snaps = snapshot(items);
    const remove = leaves(patch);
    if (remove) openNeighbour(items);
    pushUndo(labelText, snaps);
    void list.applyState(items, patch, remove).then((ok) => {
      if (ok && toast)
        showToast({
          kind: "info",
          message: toast,
          action: {
            label: "Undo",
            onClick: (dismiss) => {
              dismiss();
              setUndoStack((s) => s.filter((e) => e.snaps !== snaps));
              void restore(snaps);
            },
          },
        });
    });
  };
  const n = (items: GroupedItem[], one: string, many: string) =>
    items.length === 1 ? one : `${items.length} ${many}`;

  const ops = {
    archive: (items: GroupedItem[]) =>
      change(
        items,
        { archived: true },
        "Archive",
        n(items, "Conversation archived", "conversations archived"),
      ),
    moveToInbox: (items: GroupedItem[]) =>
      change(
        items,
        { archived: false, snoozedUntil: null },
        "Move to Inbox",
        n(items, "Moved to Inbox", "conversations moved to Inbox"),
      ),
    flag: (items: GroupedItem[], value?: boolean, remindAt?: number | null) => {
      if (!items.length) return;
      const v = value ?? !items.every((i) => i.starred);
      const patch: StatePatch = { starred: v };
      if (v && remindAt) patch.snoozedUntil = remindAt;
      change(
        items,
        patch,
        v ? "Flag" : "Clear flag",
        remindAt
          ? `Flagged. It comes back ${new Date(remindAt * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`
          : undefined,
      );
    },
    pin: (items: GroupedItem[], value?: boolean) => {
      if (!items.length) return;
      const v = value ?? !items.every((i) => i.pinned);
      change(items, { pinned: v }, v ? "Pin" : "Unpin");
    },
    snooze: (items: GroupedItem[], until: number) =>
      change(
        items,
        { snoozedUntil: until },
        "Snooze",
        `Snoozed until ${new Date(until * 1000).toLocaleString([], {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}`,
      ),
    markRead: (items: GroupedItem[]) => void list.markRead(items),
    markUnread: async (items: GroupedItem[]) => {
      if (!items.length) return;
      list.patchLocal(items, { unreadCount: 1 });
      try {
        await Promise.all(
          items.map(async (it) => {
            const emails =
              it.type === "person"
                ? (await fetchPersonEmails(it.id, { limit: 25 })).emails
                : (await fetchConversationEmails(it.id)).emails;
            const latest = [...emails]
              .sort((a, b) => b.timestamp - a.timestamp)
              .find((e) => e.type === "received");
            if (latest) await markEmailRead(latest.id, false);
          }),
        );
        list.loadStats();
      } catch (e) {
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not mark unread",
        });
        list.refresh();
      }
    },
    toggleRead: (items: GroupedItem[]) => {
      if (items.some((i) => i.unreadCount > 0)) ops.markRead(items);
      else void ops.markUnread(items);
    },
    /** Delete = move to Deleted Items (per-user Trash), with Undo. */
    delete: (items: GroupedItem[]) => {
      if (serverFolder === "trash") {
        if (canDeleteForever) return void ops.deleteForever(items);
        showToast({
          kind: "info",
          message: "Already in Deleted Items",
          description: "Only an admin can delete conversations permanently.",
        });
        return;
      }
      change(
        items,
        { trashed: true },
        "Delete",
        n(
          items,
          "Moved to Deleted Items",
          "conversations moved to Deleted Items",
        ),
      );
    },
    /** Take rows out of Deleted Items. */
    restore: (items: GroupedItem[]) =>
      change(
        items,
        { trashed: false },
        "Restore",
        n(items, "Restored", "conversations restored"),
      ),
    /** Permanent delete (people only; the server can't purge a group). */
    deleteForever: async (
      items: GroupedItem[],
      opts?: { skipConfirm?: boolean },
    ) => {
      if (!canDeleteForever) {
        showToast({
          kind: "warning",
          message: "Only an admin can delete conversations permanently",
        });
        return;
      }
      const people = items.filter((i) => i.type === "person");
      if (people.length === 0) {
        showToast({
          kind: "warning",
          message: "Group conversations can't be deleted permanently",
          description: "They stay in Deleted Items until restored.",
        });
        return;
      }
      const skipped = items.length - people.length;
      if (
        !opts?.skipConfirm &&
        !window.confirm(
          (people.length === 1
            ? `Permanently delete ${itemTitle(people[0])} and all of their mail?`
            : `Permanently delete ${people.length} people and all of their mail?`) +
            " This removes it for everyone on the team and can't be undone." +
            (skipped
              ? ` (${skipped} group conversation(s) will stay in Deleted Items.)`
              : ""),
        )
      )
        return;
      openNeighbour(people);
      await list.deletePeople(people);
    },
    /** Empty Deleted Items: permanently delete every person in Trash. */
    emptyTrash: async () => {
      if (!canDeleteForever) return;
      await emptyTrash();
      list.refresh();
    },
    /** Outlook "Always move to Focused / Other" (a per-user sender override). */
    setFocus: async (items: GroupedItem[], where: "focused" | "other") => {
      // The server applies sender overrides to person rows only, so a
      // group conversation's participants aren't touched.
      const senders = [
        ...new Set(
          items.filter((i) => i.type === "person").flatMap(senderAddresses),
        ),
      ];
      if (!senders.length) return;
      try {
        await setCategoryOverride(
          senders,
          where === "focused" ? "primary" : "promotions",
        );
        const label = where === "focused" ? "Focused" : "Other";
        showToast({
          kind: "info",
          message:
            senders.length === 1
              ? `Mail from ${senders[0]} will always go to ${label}`
              : `Mail from ${senders.length} senders will always go to ${label}`,
          action: {
            label: "Undo",
            onClick: (dismiss) => {
              dismiss();
              void setCategoryOverride(senders, null).then(() =>
                list.refresh(),
              );
            },
          },
        });
        list.refresh();
      } catch (e) {
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Couldn't move",
        });
      }
    },
    block: async (item: GroupedItem) => {
      if (item.type !== "person") {
        showToast({
          kind: "warning",
          message: "Open a single person's mail to block a sender",
        });
        return;
      }
      if (
        !window.confirm(
          `Block ${item.email}? New mail from this sender will be dropped.`,
        )
      )
        return;
      try {
        await addBlock({ type: "email", value: item.email });
        showToast({ kind: "success", message: `Blocked ${item.email}` });
        openNeighbour([item]);
        list.refresh();
      } catch {
        showToast({
          kind: "error",
          message: "Couldn't block",
          description: "This address may be one of your own.",
        });
      }
    },
    /** Mark every unread row in a folder read on the server (default: this view). */
    markAllRead: async (target?: FolderTarget) => {
      const base = target
        ? { ...folderQuery(target.folder), recipient: target.label }
        : (({ sort: _s, categories, withTabCounts: _w, ...rest }) => ({
            ...rest,
            category: categories?.length === 1 ? categories[0] : undefined,
          }))(query);
      try {
        // "Other" spans three categories; mark each.
        const cats =
          !target && query.categories && query.categories.length > 1
            ? query.categories
            : [undefined];
        let count = 0;
        for (const c of cats)
          count += await markFolderRead(c ? { ...base, category: c } : base);
        list.refresh();
        showToast({
          kind: count ? "success" : "info",
          message: count
            ? `Marked ${count} conversation${count === 1 ? "" : "s"} as read`
            : "Everything here is already read",
        });
      } catch {
        showToast({ kind: "error", message: "Couldn't mark all as read" });
      }
    },
    /** Outlook Sweep: archive or delete everything in the Inbox from a sender. */
    sweep: async (sender: string, action: "archive" | "delete") => {
      // Every Inbox row whose sender matches (server pages, exact match).
      const all: GroupedItem[] = [];
      for (let page = 1; page <= 50; page++) {
        const res = await fetchGroupedPeople({
          folder: "inbox",
          recipient: label,
          from: sender.replace(/^@/, ""),
          page,
          limit: 100,
        });
        all.push(...res.data);
        if (all.length >= res.total || res.data.length === 0) break;
      }
      const rows = sweepSelection(all, sender);
      if (!rows.length) {
        showToast({
          kind: "info",
          message: `Nothing in the Inbox from ${sender}`,
        });
        return 0;
      }
      if (action === "archive") {
        const snaps = snapshot(rows);
        openNeighbour(rows);
        pushUndo("Sweep", snaps);
        list.patchLocal(rows, {}, serverFolder === "inbox");
        await updateMailState(rows.map(itemRef), { archived: true });
        showToast({
          kind: "info",
          message: `Moved ${rows.length} conversation${rows.length === 1 ? "" : "s"} from ${sender} to Archive`,
          action: {
            label: "Undo",
            onClick: (dismiss) => {
              dismiss();
              void restore(snaps);
            },
          },
        });
        list.refresh();
      } else {
        ops.delete(rows);
      }
      return rows.length;
    },
    /** Drag-and-drop / Move to: one call per destination folder. */
    moveTo: (items: GroupedItem[], dest: MoveTarget, snoozeUntil?: number) => {
      switch (dest) {
        case "inbox":
          return ops.moveToInbox(items);
        case "archive":
          return ops.archive(items);
        case "deleted":
          return ops.delete(items);
        case "flagged":
          return ops.flag(items, true);
        case "snoozed":
          if (snoozeUntil) ops.snooze(items, snoozeUntil);
      }
    },
  };

  const goFolder = useCallback(
    (t: FolderTarget) => {
      o.closeCompose();
      navigate(folderHref(t));
    },
    [navigate, o],
  );

  const setQuery = useCallback(
    (next: string, scope?: "all" | "current") => {
      const p = new URLSearchParams(params);
      p.delete("open");
      if (next.trim()) {
        p.set("q", next.trim());
        if (scope === "current") p.set("scope", "current");
        else if (scope === "all") p.delete("scope");
      } else {
        p.delete("q");
        p.delete("scope");
      }
      navigate(`/?${p.toString()}`);
    },
    [params, navigate],
  );

  const identities = new Map(
    (list.stats?.senderIdentities ?? []).map((s) => [s.email, s.displayName]),
  );
  const folderTitle = q
    ? "Search results"
    : label
      ? identities.get(label) || label
      : FOLDER_LABELS[folder];

  // Expanded conversation rows (chevron in the list).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => setExpanded(new Set()), [folder, label, q]);
  const toggleExpanded = useCallback(
    (key: string) =>
      setExpanded((s) => {
        const next = new Set(s);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

  return {
    folder,
    urlFolder,
    label,
    q,
    parsed,
    toAsText,
    scopeCurrent,
    popout,
    folderTitle,
    filter,
    setFilter,
    sort,
    setSort,
    focusTab,
    setFocusTab,
    showFocusTabs,
    otherUnreadCount,
    otherNewCount,
    tabCounts: tc,
    list,
    canDeleteForever,
    allItems: list.items,
    filtered,
    visible,
    groups,
    order,
    hasMore: list.hasMore,
    loadMore: list.loadMore,
    selected,
    selectedItems,
    setSelected,
    cursorKey,
    setCursorKey,
    checkMode,
    setCheckMode,
    openKey,
    openedItem,
    targets,
    openItem,
    clickRow,
    toggleChecked,
    actionRows,
    selectAll,
    clearSelection,
    step: (d: 1 | -1) => stepTo(d),
    stepTo,
    ops,
    undo,
    canUndo: undoStack.length > 0,
    undoLabel: undoStack[undoStack.length - 1]?.label,
    goFolder,
    setQuery,
    autoKey,
    expanded,
    toggleExpanded,
  };
}

export type OutlookMail = ReturnType<typeof useOutlookMail>;
