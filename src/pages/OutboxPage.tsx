import { useEffect, useState } from "react";
import { Clock, RefreshCw, Send, X } from "lucide-react";
import { fetchOutbox, retryOutboxItem, cancelOutboxItem } from "@/lib/api";
import type { OutboxItem } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { SectionHeader } from "@/components/PageForm";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

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
    <span className={cn("pt-chip", status === "pending" ? "warn" : "bad")}>
      {status === "pending" ? <Clock /> : <X />}
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

      <div className="max-w-4xl space-y-6">
        <section className="overflow-hidden rounded-2xl bg-card border border-border shadow-card">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Send}
              title={`Outbox (${items.length}${nextCursor ? "+" : ""})`}
              subtitle="Successful sends never appear here."
            />
          </div>

          {error && (
            <div className="border-b border-border bg-destructive-subtle px-5 py-2 text-xs font-medium text-destructive">
              {error}
            </div>
          )}
          {notice && (
            <div className="border-b border-border bg-bg-muted px-5 py-2 text-xs font-medium text-text-secondary">
              {notice}
            </div>
          )}

          {loading ? (
            <div className="space-y-3 px-5 py-5" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <span key={i} className="pt-skel block h-4 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="pt-empty">
              <span className="ic">
                <Send size={18} />
              </span>
              <p>Nothing waiting to send. Every message went out.</p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-border-subtle">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-start gap-3 px-5 py-3.5 sm:flex-nowrap"
                  >
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
                      <Send size={15} className="text-text-secondary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-[14px] font-medium text-text-primary">
                          {item.subject}
                        </p>
                        <StatusChip status={item.status} />
                      </div>
                      <p className="mt-0.5 truncate text-[13px] text-text-tertiary">
                        To {item.toAddress} · from {item.fromAddress} ·{" "}
                        {item.attempts} attempt{item.attempts === 1 ? "" : "s"}
                        {item.status === "pending" && item.nextRetryAt
                          ? ` · next retry ${relativeTime(item.nextRetryAt)}`
                          : ""}
                      </p>
                      {item.lastError && (
                        <p className="font-code mt-1 truncate text-xs text-destructive">
                          {item.lastError}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1 max-sm:ml-12">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRetry(item)}
                        disabled={busyId === item.id}
                      >
                        <RefreshCw
                          className={busyId === item.id ? "animate-spin" : ""}
                        />
                        Retry now
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleCancel(item)}
                        disabled={busyId === item.id}
                        className="hover:bg-destructive-subtle hover:text-destructive"
                      >
                        <X />
                        Cancel
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {nextCursor && (
                <div className="border-t border-border px-5 py-3">
                  <Button
                    variant="outline"
                    onClick={loadMore}
                    className="w-full"
                  >
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </PageContainer>
  );
}
