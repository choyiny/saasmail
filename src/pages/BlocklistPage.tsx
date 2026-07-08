import { useEffect, useState } from "react";
import { ShieldBan, Plus, Trash2 } from "lucide-react";
import {
  fetchBlocklist,
  addBlock,
  removeBlock,
  purgeBlockedMail,
} from "@/lib/api";
import type { BlockRule, BlockRuleType } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { SectionHeader } from "@/components/PageForm";
import { cn } from "@/lib/utils";

function relativeTime(ts: number): string {
  const diff = ts - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 3600) return "just now";
  if (abs < 86400) return `${Math.floor(abs / 3600)}h ago`;
  return `${Math.floor(abs / 86400)}d ago`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[^\s@]+\.[^\s@]+$/;

export default function BlocklistPage() {
  const [items, setItems] = useState<BlockRule[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<BlockRuleType>("email");
  const [addValue, setAddValue] = useState("");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<BlockRule | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeSubmitting, setPurgeSubmitting] = useState(false);
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  async function loadInitial() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchBlocklist();
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch {
      setError("Failed to load blocklist.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    try {
      const res = await fetchBlocklist(nextCursor);
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch {
      setError("Failed to load more.");
    }
  }

  useEffect(() => {
    loadInitial();
  }, []);

  function resetAdd() {
    setAddType("email");
    setAddValue("");
    setAddError(null);
    setAddSubmitting(false);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const value = addValue.trim().toLowerCase();
    if (addType === "email" && !EMAIL_RE.test(value)) {
      setAddError("Enter a valid email address.");
      return;
    }
    if (addType === "domain" && !DOMAIN_RE.test(value)) {
      setAddError("Enter a bare domain, e.g. spammer.com.");
      return;
    }
    setAddSubmitting(true);
    setAddError(null);
    try {
      const created = await addBlock({ type: addType, value });
      setItems((prev) => {
        const idx = prev.findIndex((b) => b.id === created.id);
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = created;
          return copy;
        }
        return [created, ...prev];
      });
      setAddOpen(false);
      resetAdd();
    } catch {
      setAddError("Failed to add. It may be one of your own addresses.");
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;
    try {
      await removeBlock(confirmDelete.id);
      setItems((prev) => prev.filter((b) => b.id !== confirmDelete.id));
      setConfirmDelete(null);
    } catch {
      setError("Failed to remove.");
    }
  }

  async function handlePurge() {
    setPurgeSubmitting(true);
    try {
      const res = await purgeBlockedMail();
      setPurgeResult(
        `Deleted ${res.emailsDeleted} email(s) from ${res.peopleDeleted} blocked sender(s).`,
      );
    } catch {
      setPurgeResult("Failed to delete blocked mail.");
    } finally {
      setPurgeSubmitting(false);
      setPurgeOpen(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Blocklist"
        subtitle="Blocked addresses and domains are hidden from the inbox, and future mail from them is dropped."
        action={
          <button
            onClick={() => {
              resetAdd();
              setAddOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90"
          >
            <Plus size={14} />
            Add block
          </button>
        }
      />

      <div className="max-w-4xl space-y-6">
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <SectionHeader
              icon={ShieldBan}
              title={`Blocked (${items.length}${nextCursor ? "+" : ""})`}
              subtitle="Inbound mail from these senders is dropped."
            />
            <button
              onClick={() => {
                setPurgeResult(null);
                setPurgeOpen(true);
              }}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-rose-50 hover:text-rose-600"
            >
              <Trash2 size={12} />
              Delete blocked mail
            </button>
          </div>

          {error && (
            <div className="border-b border-border bg-rose-50/60 px-5 py-2 text-xs font-medium text-rose-700">
              {error}
            </div>
          )}
          {purgeResult && (
            <div className="border-b border-border bg-bg-muted px-5 py-2 text-xs font-medium text-text-secondary">
              {purgeResult}
            </div>
          )}

          {loading ? (
            <p className="px-5 py-6 text-xs font-light text-text-tertiary">
              Loading…
            </p>
          ) : items.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-text-tertiary">
              Nothing blocked yet.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-border/60">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
                      <ShieldBan size={14} className="text-text-tertiary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {item.value}
                        </p>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
                            item.type === "domain"
                              ? "bg-amber-50 text-amber-700 ring-amber-200"
                              : "bg-bg-muted text-text-secondary ring-border",
                          )}
                        >
                          {item.type === "domain" ? "Domain" : "Email"}
                        </span>
                      </div>
                      <p className="truncate text-xs font-light text-text-tertiary">
                        {item.createdBy ?? "—"} · added{" "}
                        {relativeTime(item.createdAt)}
                      </p>
                    </div>
                    <button
                      onClick={() => setConfirmDelete(item)}
                      aria-label={`Unblock ${item.value}`}
                      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                    >
                      Unblock
                    </button>
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

      {/* Add dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) resetAdd();
        }}
      >
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">Add block</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="flex gap-2">
              {(["email", "domain"] as BlockRuleType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAddType(t)}
                  className={cn(
                    "flex-1 rounded-[6px] border px-3 py-2 text-sm font-medium transition-colors",
                    addType === t
                      ? "border-text-primary bg-text-primary/5 text-text-primary"
                      : "border-border text-text-secondary hover:bg-bg-muted",
                  )}
                >
                  {t === "email" ? "Email address" : "Domain"}
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              placeholder={
                addType === "email" ? "user@example.com" : "example.com"
              }
              className="h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-text-primary/20"
            />
            {addError && (
              <p className="text-xs font-medium text-rose-600">{addError}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={addSubmitting}
                className="rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-text-primary/90 disabled:opacity-60"
              >
                {addSubmitting ? "Adding…" : "Block"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Unblock confirm */}
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
      >
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">Unblock?</DialogTitle>
          </DialogHeader>
          <p className="text-sm font-light text-text-secondary">
            <span className="font-medium text-text-primary">
              {confirmDelete?.value}
            </span>{" "}
            will be able to reach the inbox again, and any hidden mail will
            reappear.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              className="rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-text-primary/90"
            >
              Unblock
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Purge confirm */}
      <Dialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              Delete all blocked mail?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm font-light text-text-secondary">
            This permanently deletes every hidden email from blocked senders.
            This cannot be undone.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setPurgeOpen(false)}
              className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handlePurge}
              disabled={purgeSubmitting}
              className="rounded-[8px] bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-60"
            >
              {purgeSubmitting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
