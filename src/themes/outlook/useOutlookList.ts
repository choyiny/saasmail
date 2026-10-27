import { useCallback, useEffect, useRef, useState } from "react";
import {
  deletePerson,
  fetchGroupedPeople,
  fetchStats,
  markConversationsRead,
  markPeopleRead,
  updateMailState,
  type GroupedItem,
  type MailCategory,
  type MailFolder,
  type Stats,
} from "@/lib/api";
import { itemKey, itemRef } from "@/hooks/useMailList";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { onInboxRefresh } from "@/lib/inbox-events";
import { showToast } from "@/lib/toast";

/**
 * The Outlook message list. Grouped rows with optimistic mail-state
 * updates, plus what Outlook needs on top: the hasAttachment and
 * from filters, and pages that accumulate for infinite scroll (refreshes
 * reload every loaded page so rows never jump away under the user).
 */

export interface OutlookListQuery {
  folder: MailFolder;
  recipient?: string;
  q?: string;
  unread?: boolean;
  drafts?: boolean;
  sequenced?: boolean;
  hasAttachment?: boolean;
  from?: string;
  starred?: boolean;
  pinned?: boolean;
  after?: number;
  before?: number;
  subject?: string;
  sort?: "recency" | "unread" | "attachments";
  /** One server category, or several merged (Outlook "Other"). */
  categories?: MailCategory[];
  withTabCounts?: boolean;
}

export type StatePatch = {
  starred?: boolean;
  pinned?: boolean;
  archived?: boolean;
  snoozedUntil?: number | null;
  trashed?: boolean;
};

export type TabCounts = Record<MailCategory, { unread: number; new: number }>;

/** Order rows the way the server sorts them (for merged category pages). */
function compareRows(sort: OutlookListQuery["sort"]) {
  return (a: GroupedItem, b: GroupedItem) => {
    if (sort === "unread" && a.unreadCount > 0 !== b.unreadCount > 0)
      return a.unreadCount > 0 ? -1 : 1;
    if (sort === "attachments" && a.hasAttachment > 0 !== b.hasAttachment > 0)
      return a.hasAttachment > 0 ? -1 : 1;
    return b.lastEmailAt - a.lastEmailAt;
  };
}

const PAGE = 50;

export function useOutlookList(query: OutlookListQuery, enabled = true) {
  const [items, setItems] = useState<GroupedItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const req = useRef(0);
  const key = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  const [tabCounts, setTabCounts] = useState<TabCounts | null>(null);

  /** One page from the server; several categories are fetched and merged. */
  const fetchPage = async (
    page: number,
  ): Promise<{
    data: GroupedItem[];
    total: number;
    tabCounts?: TabCounts | null;
  }> => {
    const { categories, ...rest } = queryRef.current;
    const base = { ...rest, q: rest.q || undefined, page, limit: PAGE };
    if (!categories || categories.length <= 1) {
      return fetchGroupedPeople({ ...base, category: categories?.[0] });
    }
    const parts = await Promise.all(
      categories.map((category, i) =>
        fetchGroupedPeople({
          ...base,
          category,
          withTabCounts: i === 0 ? base.withTabCounts : undefined,
        }),
      ),
    );
    return {
      data: parts.flatMap((r) => r.data).sort(compareRows(rest.sort)),
      total: parts.reduce((n, r) => n + r.total, 0),
      tabCounts: parts[0]?.tabCounts,
    };
  };

  /** Load pages 1..n (n = pages loaded so far, or 1 on a new query). */
  const load = useCallback(
    async (opts?: { silent?: boolean; reset?: boolean }) => {
      const id = ++req.current;
      const n = opts?.reset ? 1 : pagesRef.current;
      if (!opts?.silent) setLoading(true);
      try {
        const res = await Promise.all(
          Array.from({ length: n }, (_, i) => fetchPage(i + 1)),
        );
        if (id !== req.current) return;
        const seen = new Set<string>();
        const rows: GroupedItem[] = [];
        for (const r of res)
          for (const it of r.data) {
            const k = itemKey(it);
            if (!seen.has(k)) {
              seen.add(k);
              rows.push(it);
            }
          }
        const multi = (queryRef.current.categories?.length ?? 0) > 1;
        setItems(multi ? rows.sort(compareRows(queryRef.current.sort)) : rows);
        setTotal(res[0]?.total ?? 0);
        if (res[0]?.tabCounts) setTabCounts(res[0].tabCounts);
        if (opts?.reset) setPages(1);
        setError(null);
      } catch (e) {
        if (id !== req.current) return;
        setError(e instanceof Error ? e.message : "Could not load mail");
      } finally {
        if (id === req.current) setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [],
  );

  const loadStats = useCallback(() => {
    fetchStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setItems([]);
    void load({ reset: true });
  }, [key, enabled, load]);

  useEffect(loadStats, [loadStats]);

  const hasMore = items.length < total;
  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;
    const next = pagesRef.current + 1;
    const id = req.current;
    setLoadingMore(true);
    try {
      const res = await fetchPage(next);
      if (id !== req.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map(itemKey));
        const next = [
          ...prev,
          ...res.data.filter((r) => !seen.has(itemKey(r))),
        ];
        return (queryRef.current.categories?.length ?? 0) > 1
          ? next.sort(compareRows(queryRef.current.sort))
          : next;
      });
      setTotal(res.total);
      setPages(next);
    } catch {
      /* the sentinel retries on the next scroll */
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loadingMore, hasMore]);

  const refresh = useCallback(() => {
    void load({ silent: true });
    loadStats();
  }, [load, loadStats]);

  useRealtimeUpdates(refresh);
  useEffect(() => onInboxRefresh(refresh), [refresh]);

  /** Patch rows in place (and optionally drop them from the view). */
  const patchLocal = useCallback(
    (targets: GroupedItem[], patch: Partial<GroupedItem>, remove = false) => {
      const keys = new Set(targets.map(itemKey));
      setItems((prev) => {
        const next = prev.map((it) =>
          keys.has(itemKey(it)) ? ({ ...it, ...patch } as GroupedItem) : it,
        );
        return remove ? next.filter((it) => !keys.has(itemKey(it))) : next;
      });
      if (remove) setTotal((t) => Math.max(0, t - keys.size));
    },
    [],
  );

  /** Optimistic mail-state change; reloads on failure. */
  const applyState = useCallback(
    async (targets: GroupedItem[], patch: StatePatch, remove: boolean) => {
      if (targets.length === 0) return false;
      const local: Partial<GroupedItem> = {};
      if (patch.starred !== undefined) local.starred = patch.starred;
      if (patch.pinned !== undefined) local.pinned = patch.pinned;
      if (patch.archived !== undefined)
        local.archivedAt = patch.archived
          ? Math.floor(Date.now() / 1000)
          : null;
      if (patch.snoozedUntil !== undefined)
        local.snoozedUntil = patch.snoozedUntil;
      if (patch.trashed !== undefined)
        local.trashedAt = patch.trashed ? Math.floor(Date.now() / 1000) : null;
      patchLocal(targets, local, remove);
      try {
        await updateMailState(targets.map(itemRef), patch);
        return true;
      } catch (e) {
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not update mail",
        });
        void load({ silent: true });
        return false;
      }
    },
    [patchLocal, load],
  );

  const markRead = useCallback(
    async (targets: GroupedItem[]) => {
      const t = targets.filter((x) => x.unreadCount > 0);
      if (!t.length) return;
      patchLocal(t, { unreadCount: 0 });
      try {
        const people = t.filter((x) => x.type === "person").map((x) => x.id);
        const groups = t.filter((x) => x.type === "group").map((x) => x.id);
        await Promise.all([
          people.length ? markPeopleRead(people) : null,
          groups.length ? markConversationsRead(groups) : null,
        ]);
        loadStats();
      } catch (e) {
        showToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not mark read",
        });
        void load({ silent: true });
      }
    },
    [patchLocal, loadStats, load],
  );

  const deletePeople = useCallback(
    async (targets: GroupedItem[]) => {
      const people = targets.filter((t) => t.type === "person");
      if (!people.length) return;
      patchLocal(people, {}, true);
      try {
        await Promise.all(people.map((p) => deletePerson(p.id)));
        showToast({
          kind: "success",
          message:
            people.length === 1
              ? "Conversation deleted permanently"
              : `${people.length} conversations deleted permanently`,
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
    [patchLocal, loadStats, load],
  );

  return {
    items,
    total,
    loading,
    loadingMore,
    error,
    stats,
    hasMore,
    loadMore,
    tabCounts,
    refresh,
    loadStats,
    patchLocal,
    applyState,
    markRead,
    deletePeople,
  };
}

export type OutlookList = ReturnType<typeof useOutlookList>;
