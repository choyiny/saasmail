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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  { label: string; chip: string }
> = {
  unsubscribe: { label: "Unsubscribed", chip: "accent" },
  manual: { label: "Manual", chip: "" },
  hard_bounce: { label: "Hard bounce", chip: "bad" },
  soft_bounce: { label: "Soft bounces", chip: "warn" },
  complaint: { label: "Marked as spam", chip: "bad" },
  provider: { label: "Provider list", chip: "warn" },
};

/** Cloudflare keeps these on its own list too (docs/suppressions.md). */
const PROVIDER_LISTED: Suppression["reason"][] = [
  "hard_bounce",
  "complaint",
  "provider",
];
const PROVIDER_NOTE =
  "Cloudflare keeps its own suppression list. Removing the address here does not remove it there: remove it in the Cloudflare dashboard too.";

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
          <Button
            onClick={() => {
              resetAddDialog();
              setAddOpen(true);
            }}
          >
            <Plus />
            Add suppression
          </Button>
        }
      />

      <div className="max-w-4xl space-y-6">
        <section className="overflow-hidden rounded-2xl bg-card border border-border shadow-card">
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
            <div className="border-b border-border bg-destructive-subtle px-5 py-2 text-xs font-medium text-destructive">
              {error}
            </div>
          )}

          {loading ? (
            <div className="space-y-3 px-5 py-5" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="pt-skel block h-4 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Ban}
              title="No suppressions yet"
              hint="Recipients who unsubscribe land here automatically."
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="pt-table">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>Reason</th>
                      <th className="hidden md:table-cell">Source</th>
                      <th>Added</th>
                      <th className="w-0">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const meta = REASON_META[item.reason];
                      return (
                        <tr key={item.id}>
                          <td className="max-w-[260px] truncate font-medium">
                            {item.email}
                          </td>
                          <td>
                            <span
                              className={cn("pt-chip", meta.chip)}
                              title={
                                PROVIDER_LISTED.includes(item.reason)
                                  ? PROVIDER_NOTE
                                  : undefined
                              }
                            >
                              {meta.label}
                            </span>
                          </td>
                          <td className="muted hidden md:table-cell">
                            {item.source ?? "—"}
                          </td>
                          <td
                            className="muted whitespace-nowrap"
                            title={formatDate(item.createdAt)}
                          >
                            {relativeTime(item.createdAt)}
                          </td>
                          <td className="!py-1.5 text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setDeleteError(null);
                                setConfirmDelete(item);
                              }}
                              aria-label={`Remove suppression for ${item.email}`}
                              className="hover:bg-destructive-subtle hover:text-destructive"
                            >
                              <Trash2 />
                              Remove
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {nextCursor && (
                <div className="border-t border-border px-5 py-3">
                  <Button
                    variant="outline"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add suppression</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="suppression-email"
                className="block text-[13px] font-medium text-text-primary"
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
                className="h-9 w-full rounded-lg border border-border-strong bg-card px-3 text-sm text-text-primary shadow-card transition-[border-color,box-shadow] placeholder:text-text-tertiary hover:border-text-tertiary/60 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15"
              />
              <p className="text-xs text-text-tertiary">
                Future marketing and sequence sends to this address will be
                skipped.
              </p>
            </div>

            {addError && (
              <p className="text-xs font-medium text-destructive">{addError}</p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-card font-medium text-text-primary transition-colors hover:bg-bg-subtle hover:text-text-primary h-9 px-3.5 text-[13.5px] shadow-card"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={addSubmitting}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60 h-9 px-3.5 text-[13.5px]"
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove suppression?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            <span className="font-medium text-text-primary">
              {confirmDelete?.email}
            </span>{" "}
            will receive marketing and sequence sends again. You can re-add the
            suppression later.
          </p>
          {confirmDelete && PROVIDER_LISTED.includes(confirmDelete.reason) && (
            <p
              className="text-sm text-text-secondary"
              data-testid="suppression-provider-note"
            >
              {PROVIDER_NOTE}
            </p>
          )}

          {deleteError && (
            <p className="text-xs font-medium text-destructive">
              {deleteError}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-card font-medium text-text-primary transition-colors hover:bg-bg-subtle hover:text-text-primary h-9 px-3.5 text-[13.5px] shadow-card"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              disabled={deleteSubmitting}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-destructive font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60 h-9 px-3.5 text-[13.5px]"
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
    <div className="pt-empty">
      <span className="ic">
        <Icon size={18} />
      </span>
      <p className="font-medium text-text-primary">{title}</p>
      <p className="-mt-2 text-[13px]">{hint}</p>
    </div>
  );
}
