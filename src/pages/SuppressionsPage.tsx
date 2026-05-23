import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Ban, Plus, Trash2 } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import {
  fetchSuppressions,
  createSuppression,
  deleteSuppression,
} from "@/lib/api";
import type { Suppression } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { SectionHeader } from "@/components/PageForm";
import { cn } from "@/lib/utils";

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString();
}

function relativeTime(ts: number): string {
  const diff = ts - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 3600) return diff < 0 ? "just now" : "in <1h";
  if (abs < 86400)
    return diff < 0
      ? `${Math.floor(abs / 3600)}h ago`
      : `in ${Math.floor(abs / 3600)}h`;
  const days = Math.floor(abs / 86400);
  return diff < 0 ? `${days}d ago` : `in ${days}d`;
}

const REASON_META: Record<
  Suppression["reason"],
  { label: string; chipClass: string; color: string }
> = {
  unsubscribe: {
    label: "Unsubscribed",
    chipClass: "bg-violet/10 ring-violet/20",
    color: "#7c5cfc",
  },
  manual: {
    label: "Manual",
    chipClass: "bg-bg-muted ring-border",
    color: "#6b7280",
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SuppressionsPage() {
  const { data: session } = useSession();
  const [items, setItems] = useState<Suppression[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<Suppression | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function loadInitial() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSuppressions();
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch {
      setError("Failed to load suppressions.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await fetchSuppressions(nextCursor);
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch {
      setError("Failed to load more.");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (session?.user?.role === "admin") loadInitial();
  }, [session]);

  if (session?.user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  function resetAddDialog() {
    setAddEmail("");
    setAddError(null);
    setAddSubmitting(false);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const email = addEmail.trim().toLowerCase();
    if (!email) {
      setAddError("Email is required.");
      return;
    }
    if (!EMAIL_RE.test(email)) {
      setAddError("Enter a valid email address.");
      return;
    }
    setAddSubmitting(true);
    setAddError(null);
    try {
      const created = await createSuppression(email);
      setItems((prev) => {
        // Idempotent on the server — if it's already in the list, refresh it
        // in place; otherwise prepend.
        const idx = prev.findIndex((s) => s.id === created.id);
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = created;
          return copy;
        }
        return [created, ...prev];
      });
      setAddOpen(false);
      resetAddDialog();
    } catch {
      setAddError("Failed to add suppression. Please try again.");
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;
    setDeleteSubmitting(true);
    setDeleteError(null);
    try {
      await deleteSuppression(confirmDelete.id);
      setItems((prev) => prev.filter((s) => s.id !== confirmDelete.id));
      setConfirmDelete(null);
    } catch {
      setDeleteError("Failed to remove. Please try again.");
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Suppressions"
        subtitle="Email addresses that won't receive marketing or sequence sends."
        action={
          <button
            onClick={() => {
              resetAddDialog();
              setAddOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90"
          >
            <Plus size={14} />
            Add suppression
          </button>
        }
      />

      <div className="max-w-4xl space-y-6">
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Ban}
              title={`Suppressed addresses (${items.length}${
                nextCursor ? "+" : ""
              })`}
              subtitle="Outbound /api/send and sequence emails skip these recipients."
            />
          </div>

          {error && (
            <div className="border-b border-border bg-rose-50/60 px-5 py-2 text-xs font-medium text-rose-700">
              {error}
            </div>
          )}

          {loading ? (
            <p className="px-5 py-6 text-xs font-light text-text-tertiary">
              Loading…
            </p>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Ban}
              title="No suppressions yet"
              hint="Recipients who unsubscribe land here automatically. You can also add one manually above."
            />
          ) : (
            <>
              <ul className="divide-y divide-border/60">
                {items.map((item) => {
                  const meta = REASON_META[item.reason];
                  return (
                    <li
                      key={item.id}
                      className="flex items-center gap-3 px-5 py-3"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
                        <Ban size={14} className="text-text-tertiary" />
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {item.email}
                          </p>
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
                              meta.chipClass,
                            )}
                            style={{ color: meta.color }}
                          >
                            {meta.label}
                          </span>
                        </div>
                        <p className="truncate text-xs font-light text-text-tertiary">
                          {item.source ?? "—"} · added{" "}
                          {relativeTime(item.createdAt)} (
                          {formatDate(item.createdAt)})
                        </p>
                      </div>

                      <button
                        onClick={() => {
                          setDeleteError(null);
                          setConfirmDelete(item);
                        }}
                        aria-label={`Remove suppression for ${item.email}`}
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-rose-50 hover:text-rose-600"
                      >
                        <Trash2 size={12} />
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>

              {nextCursor && (
                <div className="border-t border-border px-5 py-3">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full rounded-[6px] border border-border bg-card py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* --- Add suppression dialog --- */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) resetAddDialog();
        }}
      >
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              Add suppression
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="suppression-email"
                className="block text-[11px] font-medium uppercase tracking-wider text-text-tertiary"
              >
                Email
              </label>
              <input
                id="suppression-email"
                type="email"
                autoFocus
                required
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                placeholder="user@example.com"
                className="h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-text-primary/20"
              />
              <p className="text-[11px] font-light text-text-tertiary">
                Future marketing and sequence sends to this address will be
                skipped.
              </p>
            </div>

            {addError && (
              <p className="text-xs font-medium text-rose-600">{addError}</p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={addSubmitting}
                className="rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {addSubmitting ? "Adding…" : "Add suppression"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* --- Confirm remove dialog --- */}
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmDelete(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              Remove suppression?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm font-light text-text-secondary">
            <span className="font-medium text-text-primary">
              {confirmDelete?.email}
            </span>{" "}
            will receive marketing and sequence sends again. You can re-add the
            suppression later.
          </p>

          {deleteError && (
            <p className="text-xs font-medium text-rose-600">{deleteError}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              disabled={deleteSubmitting}
              className="rounded-[8px] bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleteSubmitting ? "Removing…" : "Remove"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

/* --------------------------------- helpers --------------------------------- */

function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ElementType;
  title: string;
  hint: string;
}) {
  return (
    <div className="px-5 py-10 text-center">
      <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-violet/10">
        <Icon size={16} style={{ color: "#7c5cfc" }} />
      </span>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="mt-1 text-xs font-light text-text-tertiary">{hint}</p>
    </div>
  );
}
