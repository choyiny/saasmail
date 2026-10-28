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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      setError("Failed to delete blocked mail.");
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
          <Button
            onClick={() => {
              resetAdd();
              setAddOpen(true);
            }}
          >
            <Plus />
            Add block
          </Button>
        }
      />

      <div className="max-w-4xl space-y-6">
        <section className="overflow-hidden rounded-2xl bg-card border border-border shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <SectionHeader
              icon={ShieldBan}
              title={`Blocked (${items.length}${nextCursor ? "+" : ""})`}
              subtitle="Inbound mail from these senders is dropped."
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPurgeResult(null);
                setPurgeOpen(true);
              }}
              className="shrink-0 hover:bg-destructive-subtle hover:text-destructive"
            >
              <Trash2 />
              Delete blocked mail
            </Button>
          </div>

          {error && (
            <div className="border-b border-border bg-destructive-subtle px-5 py-2 text-xs font-medium text-destructive">
              {error}
            </div>
          )}
          {purgeResult && (
            <div className="border-b border-border bg-bg-muted px-5 py-2 text-xs font-medium text-text-secondary">
              {purgeResult}
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
                <ShieldBan size={18} />
              </span>
              <p>Nothing is blocked. Block a sender from any conversation.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="pt-table">
                  <thead>
                    <tr>
                      <th>Sender</th>
                      <th>Type</th>
                      <th className="hidden md:table-cell">Added by</th>
                      <th>Added</th>
                      <th className="w-0">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td className="max-w-[260px] truncate font-medium">
                          {item.value}
                        </td>
                        <td>
                          <span
                            className={cn(
                              "pt-chip",
                              item.type === "domain" && "warn",
                            )}
                          >
                            {item.type === "domain" ? "Domain" : "Email"}
                          </span>
                        </td>
                        <td className="muted hidden max-w-[200px] truncate md:table-cell">
                          {item.createdBy ?? "—"}
                        </td>
                        <td className="muted whitespace-nowrap">
                          {relativeTime(item.createdAt)}
                        </td>
                        <td className="!py-1.5 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmDelete(item)}
                            aria-label={`Unblock ${item.value}`}
                          >
                            Unblock
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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

      {/* Add dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) resetAdd();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add block</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="pt-seg flex w-full" role="radiogroup">
              {(["email", "domain"] as BlockRuleType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={addType === t}
                  onClick={() => setAddType(t)}
                  className="flex-1"
                >
                  {t === "email" ? "Email address" : "Domain"}
                </button>
              ))}
            </div>
            <Input
              autoFocus
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              placeholder={
                addType === "email" ? "user@example.com" : "example.com"
              }
            />
            {addError && (
              <p className="text-xs font-medium text-destructive">{addError}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-card font-medium text-text-primary transition-colors hover:bg-bg-subtle h-9 px-3.5 text-[13.5px] shadow-card"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={addSubmitting}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-60 h-9 px-3.5 text-[13.5px]"
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unblock?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
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
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-card font-medium text-text-primary transition-colors hover:bg-bg-subtle h-9 px-3.5 text-[13.5px] shadow-card"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent font-medium text-accent-foreground transition-colors hover:bg-accent-hover h-9 px-3.5 text-[13.5px]"
            >
              Unblock
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Purge confirm */}
      <Dialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all blocked mail?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            This permanently deletes every hidden email from blocked senders.
            This cannot be undone.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setPurgeOpen(false)}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-card font-medium text-text-primary transition-colors hover:bg-bg-subtle h-9 px-3.5 text-[13.5px] shadow-card"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handlePurge}
              disabled={purgeSubmitting}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-destructive font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-60 h-9 px-3.5 text-[13.5px]"
            >
              {purgeSubmitting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
