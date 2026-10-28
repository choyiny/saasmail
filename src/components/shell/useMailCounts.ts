import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { fetchOutboxCount, fetchStats, type Stats } from "@/lib/api";
import { onInboxRefresh } from "@/lib/inbox-events";

const COUNTS_EVENT = "saasmail:mail-counts";

/** Ask the rail to refetch its unread / outbox counts. */
export function refreshMailCounts(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(COUNTS_EVENT));
}

/** Unread count, inbox addresses and pending outbox count for the rail. */
export function useMailCounts() {
  const { pathname, search } = useLocation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [outboxPending, setOutboxPending] = useState(0);
  const [nonce, setNonce] = useState(0);

  useEffect(() => onInboxRefresh(() => setNonce((n) => n + 1)), []);
  useEffect(() => {
    const on = () => setNonce((n) => n + 1);
    window.addEventListener(COUNTS_EVENT, on);
    return () => window.removeEventListener(COUNTS_EVENT, on);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNonce((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    fetchStats()
      .then((s) => alive && setStats(s))
      .catch(() => {});
    fetchOutboxCount()
      .then((r) => alive && setOutboxPending(r.pending))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pathname, search, nonce]);

  return {
    unread: stats?.unreadCount ?? 0,
    inboxes: stats?.senderIdentities ?? [],
    outboxPending,
  };
}
