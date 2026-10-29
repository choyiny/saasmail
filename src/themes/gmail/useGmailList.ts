import { useCallback, useEffect, useRef, useState } from "react";
import {
  deletePerson,
  fetchGroupedIds,
  fetchGroupedPeople,
  fetchStats,
  markConversationsRead,
  markPeopleRead,
  undoMailState,
  updateMailState,
  type GroupedItem,
  type InboxSort,
  type MailCategory,
  type MailFolder,
  type MailItemRef,
  type Stats,
} from "@/lib/api";
import { itemKey, itemRef } from "@/hooks/useMailList";
import {
  applyToFolder,
  markFolderRead,
  pinUndo,
  undoFolderChange,
} from "@/lib/folder-actions";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { onInboxRefresh } from "@/lib/inbox-events";
import { showToast } from "@/lib/toast";

/**
 * The Gmail layout's list data: grouped rows with optimistic mail-state
 * updates, plus the Gmail-only filters (category tab, sender, attachment, sort), an undo
 * stack for the `z` shortcut and a "load every page" helper for
 * "Select all N conversations".
 */

export interface GmailListQuery {
  folder: MailFolder;
  recipient?: string;
  q?: string;
  unread?: boolean;
  drafts?: boolean;
  sequenced?: boolean;
  hasAttachment?: boolean;
  from?: string;
  category?: MailCategory;
  starred?: boolean;
  after?: number;
  before?: number;
  subject?: string;
  sort?: InboxSort;
}

export const PAGE_SIZE = 50;

type StatePatch = {
  starred?: boolean;
  pinned?: boolean;
  archived?: boolean;
  snoozedUntil?: number | null;
  trashed?: boolean;
};

function plural(n: number, one: string, many = `${one}s`) {
  return n === 1 ? `Conversation ${one}` : `${n} conversations ${many}`;
}

export function useGmailList(query: GmailListQuery) {
  const [items, setItems] = useState<GroupedItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [lastLoaded, setLastLoaded] = useState<number | null>(null);
  const reqId = useRef(0);
  const undoRef = useRef<(() => void) | null>(null);

  const {
    folder,
    recipient,
    q,
    unread,
    drafts,
    sequenced,
    hasAttachment,
    from,
    category,
    starred,
    after,
    before,
    subject,
    sort,
  } = query;
  const key = JSON.stringify([
    folder,
    recipient,
    q,
    unread,
    drafts,
    sequenced,
    hasAttachment,
    from,
    category,
    starred,
    after,
    before,
    subject,
    sort,
  ]);

  const params = useCallback(
    () => ({
      folder,
      recipient,
      q: q || undefined,
      unread,
      drafts,
      sequenced,
      hasAttachment,
      from: from || undefined,
      category,
      starred,
      after,
      before,
      subject: subject || undefined,
      sort,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const id = ++reqId.current;
      if (!opts?.silent) setLoading(true);
      try {
        const res = await fetchGroupedPeople({
          ...params(),
          page,
          limit: PAGE_SIZE,
        });
        if (id !== reqId.current) return;
        setItems(res.data);
        setTotal(res.total);
        setError(null);
        setLastLoaded(Date.now());
      } catch (e) {
        if (id !== reqId.current) return;
        setError(e instanceof Error ? e.message : "Could not load mail");
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [params, page],
  );

  const loadStats = useCallback(() => {
    fetchStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const refresh = useCallback(() => {
    void load({ silent: true });
    loadStats();
  }, [load, loadStats]);

  useRealtimeUpdates(refresh);
  useEffect(() => onInboxRefresh(refresh), [refresh]);

  /** Every row matching the current filters (for "Select all N"). */
  const fetchAll = useCallback(async (): Promise<MailItemRef[]> => {
    const res = await fetchGroupedIds(params());
    return res.data.map(({ type, id }) => ({ type, id }));
  }, [params]);

  /** The current filters, for whole-folder server actions. */
  const folderParams = params;

  const refreshAll = () => {
    void load({ silent: true });
    loadStats();
  };

  const inFolderAfter = (patch: StatePatch): boolean => {
    if (folder === "inbox")
      return !patch.archived && !(patch.snoozedUntil ?? null);
    if (folder === "archive") return patch.archived !== false;
    if (folder === "snoozed") return patch.snoozedUntil !== null;
    if (folder === "starred") return patch.starred !== false;
    return true;
  };

  const applyState = useCallback(
    async (
      targets: GroupedItem[],
      patch: StatePatch,
      opts?: { removeFromView?: boolean; message?: string; undo?: StatePatch },
    ) => {
      if (targets.length === 0) return;
      const keys = new Set(targets.map(itemKey));
      let before: GroupedItem[] = [];
      setItems((prev) => {
        before = prev;
        const next = prev.map((it) =>
          keys.has(itemKey(it))
            ? {
                ...it,
                ...(patch.starred !== undefined && { starred: patch.starred }),
                ...(patch.pinned !== undefined && { pinned: patch.pinned }),
                ...(patch.archived !== undefined && {
                  archivedAt: patch.archived
                    ? Math.floor(Date.now() / 1000)
                    : null,
                }),
                ...(patch.snoozedUntil !== undefined && {
                  snoozedUntil: patch.snoozedUntil,
                }),
                ...(patch.trashed !== undefined && {
                  trashedAt: patch.trashed
                    ? Math.floor(Date.now() / 1000)
                    : null,
                }),
              }
            : it,
        );
        return opts?.removeFromView
          ? next.filter((it) => !keys.has(itemKey(it)))
          : next;
      });
      if (opts?.removeFromView) setTotal((t) => Math.max(0, t - keys.size));
      // Undo puts back exactly what changed (docs/mailbox-state.md). It is
      // armed before the request answers, as upstream, so `z` works at once:
      // it waits for the answer's steps. If the change fails, there is
      // nothing to undo and the catch below refetches.
      const pending = updateMailState(targets.map(itemRef), patch);
      const pins = pinUndo(targets, patch.pinned);
      const undo = opts?.undo
        ? () => {
            undoRef.current = null;
            pending.then(
              (res) =>
                undoMailState(res.undo)
                  .then(() =>
                    pins
                      ? updateMailState(pins.items, { pinned: pins.pinned })
                      : undefined,
                  )
                  .then(() => load({ silent: true }))
                  .catch(() =>
                    showToast({ kind: "error", message: "Couldn't undo" }),
                  ),
              () => undefined,
            );
          }
        : null;
      undoRef.current = undo;
      try {
        await pending;
        if (opts?.message) {
          showToast({
            kind: "info",
            message: opts.message,
            action: undo
              ? {
                  label: "Undo",
                  onClick: (dismiss) => {
                    dismiss();
                    undo();
                  },
                }
              : undefined,
          });
        }
      } catch (e) {
        setItems(before);
        if (undoRef.current === undo) undoRef.current = null;
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not update mail",
        });
        void load({ silent: true });
      }
    },
    [load],
  );

  const actions = {
    toggleStar: (targets: GroupedItem[], starred?: boolean) => {
      const value = starred ?? !targets.every((t) => t.starred);
      return applyState(
        targets,
        { starred: value },
        {
          removeFromView: folder === "starred" && !value,
          message: value
            ? plural(targets.length, "starred")
            : plural(targets.length, "unstarred"),
          undo: { starred: !value },
        },
      );
    },
    togglePin: (targets: GroupedItem[], pinned?: boolean) => {
      const value = pinned ?? !targets.every((t) => t.pinned);
      return applyState(
        targets,
        { pinned: value },
        {
          message: value
            ? plural(targets.length, "pinned to the top")
            : plural(targets.length, "unpinned"),
          undo: { pinned: !value },
        },
      ).then(() => (folder === "inbox" ? load({ silent: true }) : undefined));
    },
    archive: (targets: GroupedItem[], verb = "archived") =>
      applyState(
        targets,
        { archived: true },
        {
          removeFromView: !inFolderAfter({ archived: true }),
          message: plural(targets.length, verb),
          undo: { archived: false },
        },
      ),
    unarchive: (targets: GroupedItem[]) =>
      applyState(
        targets,
        { archived: false },
        {
          removeFromView: folder === "archive",
          message:
            targets.length === 1
              ? "Conversation moved to Inbox"
              : `${targets.length} conversations moved to Inbox`,
          undo: { archived: true },
        },
      ),
    snooze: (targets: GroupedItem[], until: number) =>
      applyState(
        targets,
        { snoozedUntil: until },
        {
          removeFromView: !inFolderAfter({ snoozedUntil: until }),
          undo: { snoozedUntil: null },
          message: `${targets.length === 1 ? "Conversation" : `${targets.length} conversations`} snoozed until ${new Date(
            until * 1000,
          ).toLocaleString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}`,
        },
      ),
    trash: (targets: GroupedItem[]) =>
      applyState(
        targets,
        { trashed: true },
        {
          removeFromView: folder !== "all",
          message:
            targets.length === 1
              ? "Conversation moved to Trash"
              : `${targets.length} conversations moved to Trash`,
          undo: { trashed: false },
        },
      ),
    restore: (targets: GroupedItem[]) =>
      applyState(
        targets,
        { trashed: false },
        {
          removeFromView: folder === "trash",
          message:
            targets.length === 1
              ? "Conversation restored"
              : `${targets.length} conversations restored`,
          undo: { trashed: true },
        },
      ),
    /** Mark every unread row matching the filters read (whole folder). */
    markAllRead: async () => {
      try {
        const n = await markFolderRead(params());
        setItems((prev) => prev.map((it) => ({ ...it, unreadCount: 0 })));
        showToast({
          kind: "info",
          message:
            n === 0
              ? "Nothing to mark as read"
              : `${n} conversation${n === 1 ? "" : "s"} marked as read`,
        });
        refreshAll();
      } catch (e) {
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not mark read",
        });
      }
    },
    /** Apply a state patch to every row matching the filters. */
    applyToAll: async (
      patch: StatePatch,
      message: string,
      undo?: StatePatch,
    ) => {
      try {
        const res = await applyToFolder(params(), patch);
        const undoFn = undo
          ? () => {
              undoRef.current = null;
              undoFolderChange(res)
                .then(() => load({ silent: true }))
                .catch(() =>
                  showToast({ kind: "error", message: "Couldn't undo" }),
                );
            }
          : null;
        undoRef.current = undoFn;
        showToast({
          kind: "info",
          message: message.replace("{n}", String(res.rows)),
          action: undoFn
            ? {
                label: "Undo",
                onClick: (dismiss) => {
                  dismiss();
                  undoFn();
                },
              }
            : undefined,
        });
        refreshAll();
      } catch (e) {
        // A failure part-way leaves some rows changed, and an older Undo
        // no longer matches them: refetch and drop it.
        undoRef.current = null;
        void load({ silent: true });
        refreshAll();
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not update mail",
        });
      }
    },
    unsnooze: (targets: GroupedItem[]) =>
      applyState(
        targets,
        { snoozedUntil: null },
        {
          removeFromView: folder === "snoozed",
          message:
            targets.length === 1
              ? "Conversation unsnoozed"
              : `${targets.length} conversations unsnoozed`,
        },
      ),
    markRead: async (targets: GroupedItem[], opts?: { quiet?: boolean }) => {
      const people = targets
        .filter((t) => t.type === "person")
        .map((t) => t.id);
      const groups = targets.filter((t) => t.type === "group").map((t) => t.id);
      const keys = new Set(targets.map(itemKey));
      setItems((prev) =>
        prev.map((it) =>
          keys.has(itemKey(it)) ? { ...it, unreadCount: 0 } : it,
        ),
      );
      try {
        await Promise.all([
          people.length ? markPeopleRead(people) : null,
          groups.length ? markConversationsRead(groups) : null,
        ]);
        if (!opts?.quiet && targets.length > 1)
          showToast({
            kind: "info",
            message: `${targets.length} conversations marked as read`,
          });
        loadStats();
      } catch (e) {
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not mark read",
        });
        void load({ silent: true });
      }
    },
    /** Permanently delete people (and their mail). Groups are skipped. */
    deleteForever: async (targets: GroupedItem[]) => {
      const people = targets.filter((t) => t.type === "person");
      if (people.length === 0) return;
      const keys = new Set(people.map(itemKey));
      setItems((prev) => prev.filter((it) => !keys.has(itemKey(it))));
      setTotal((t) => Math.max(0, t - keys.size));
      undoRef.current = null;
      try {
        await Promise.all(people.map((p) => deletePerson(p.id)));
        showToast({
          kind: "success",
          message:
            people.length === 1
              ? "Conversation deleted forever"
              : `${people.length} conversations deleted forever`,
        });
        loadStats();
      } catch (e) {
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not delete",
        });
        void load({ silent: true });
      }
    },
  };

  const undoLast = useCallback(() => {
    const fn = undoRef.current;
    if (!fn) {
      showToast({ kind: "info", message: "Nothing to undo" });
      return;
    }
    fn();
    showToast({ kind: "info", message: "Action undone" });
  }, []);

  return {
    items,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    setPage,
    loading,
    error,
    stats,
    refresh,
    reload: load,
    lastLoaded,
    actions,
    fetchAll,
    folderParams,
    undoLast,
    /** Record a custom undo for `z` (e.g. mark unread). */
    setUndo: (fn: (() => void) | null) => {
      undoRef.current = fn;
    },
  };
}

export type GmailList = ReturnType<typeof useGmailList>;
