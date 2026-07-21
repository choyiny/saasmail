import { useEffect, useState } from "react";
import { Clock, RefreshCw, Send, X } from "lucide-react";
import { fetchOutbox, retryOutboxItem, cancelOutboxItem } from "@/lib/api";
import type { OutboxItem } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { SectionHeader } from "@/components/PageForm";
import { cn } from "@/lib/utils";

function relativeTime(ts: number): string {
  const diff = ts - Date.now() / 1000;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "from now" : "ago";
  if (abs < 60) return diff >= 0 ? "any moment" : "just now";
  if (abs < 3600) return `${Math.floor(abs / 60)}m ${suffix}`;
  if (abs < 86400) return `${Math.floor(abs / 3600)}h ${suffix}`;
  return `${Math.floor(abs / 86400)}d ${suffix}`;
}

function StatusChip({ status }: { status: OutboxItem["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
        status === "pending"
          ? "bg-amber-50 text-amber-700 ring-amber-200"
          : "bg-rose-50 text-rose-700 ring-rose-200",
      )}
    >
      {status === "pending" ? <Clock size={10} /> : <X size={10} />}
      {status === "pending" ? "Retrying" : "Failed"}
    </span>
  );
}

export default function OutboxPage() {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadInitial() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchOutbox();
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch {
      setError("Failed to load the outbox.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    try {
      const res = await fetchOutbox(nextCursor);
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch {
      setError("Failed to load more.");
    }
  }

  useEffect(() => {
    loadInitial();
  }, []);

  async function handleRetry(item: OutboxItem) {
    setBusyId(item.id);
    setNotice(null);
    try {
      const res = await retryOutboxItem(item.id);
      if (res.outcome === "sent" || res.outcome === "suppressed") {
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        setNotice(
          res.outcome === "sent"
            ? `Sent to ${item.toAddress}.`
            : `${item.toAddress} is suppressed — send cancelled.`,
        );
      } else {
        setNotice(
          res.outcome === "failed"
            ? `Still failing — the provider rejected the send again.`
            : `Retry attempted — still waiting on the provider.`,
        );
        await loadInitial();
      }
    } catch {
      setError("Retry failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(item: OutboxItem) {
    setBusyId(item.id);
    setNotice(null);
    try {
      await cancelOutboxItem(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setNotice(`Cancelled the send to ${item.toAddress}.`);
    } catch {
      setError("Cancel failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Outbox"
        subtitle="Sends the provider rejected. Retrying items are re-attempted every hour; failed items gave up and need a manual retry."
      />

      <div className="space-y-6">
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Send}
              title={`Outbox (${items.length}${nextCursor ? "+" : ""})`}
              subtitle="Successful sends never appear here."
            />
          </div>

          {error && (
            <div className="border-b border-border bg-rose-50/60 px-5 py-2 text-xs font-medium text-rose-700">
              {error}
            </div>
          )}
          {notice && (
            <div className="border-b border-border bg-bg-muted px-5 py-2 text-xs font-medium text-text-secondary">
              {notice}
            </div>
          )}

          {loading ? (
            <p className="px-5 py-6 text-xs font-light text-text-tertiary">
              Loading…
            </p>
          ) : items.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-text-tertiary">
              Nothing waiting to send.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-border/60">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start gap-3 px-5 py-3"
                  >
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
                      <Send size={14} className="text-text-tertiary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {item.subject}
                        </p>
                        <StatusChip status={item.status} />
                      </div>
                      <p className="truncate text-xs font-light text-text-tertiary">
                        To {item.toAddress} · from {item.fromAddress} ·{" "}
                        {item.attempts} attempt{item.attempts === 1 ? "" : "s"}
                        {item.status === "pending" && item.nextRetryAt
                          ? ` · next retry ${relativeTime(item.nextRetryAt)}`
                          : ""}
                      </p>
                      {item.lastError && (
                        <p className="mt-0.5 truncate text-xs font-light text-rose-600">
                          {item.lastError}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => handleRetry(item)}
                        disabled={busyId === item.id}
                        className="inline-flex h-8 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-60"
                      >
                        <RefreshCw
                          size={12}
                          className={busyId === item.id ? "animate-spin" : ""}
                        />
                        Retry now
                      </button>
                      <button
                        onClick={() => handleCancel(item)}
                        disabled={busyId === item.id}
                        className="inline-flex h-8 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-60"
                      >
                        <X size={12} />
                        Cancel
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {nextCursor && (
                <div className="border-t border-border px-5 py-3">
                  <button
                    onClick={loadMore}
                    className="w-full rounded-[6px] border border-border bg-card py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                  >
                    Load more
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </PageContainer>
  );
}
