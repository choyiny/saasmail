import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Archive, Plus, Users } from "lucide-react";
import {
  createList,
  deleteList,
  fetchLists,
  type SubscriberList,
} from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export default function ListsPage() {
  const [lists, setLists] = useState<SubscriberList[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    description: "",
    fromAddress: "",
    doubleOptIn: true,
  });

  useEffect(() => {
    setLoading(true);
    fetchLists({ includeArchived: showArchived })
      .then((r) => setLists(r.items))
      .finally(() => setLoading(false));
  }, [showArchived]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await createList({
        name: form.name.trim(),
        description: form.description.trim() || null,
        fromAddress: form.fromAddress.trim(),
        doubleOptIn: form.doubleOptIn,
      });
      setLists((prev) => [created, ...prev]);
      setOpen(false);
      setForm({
        name: "",
        description: "",
        fromAddress: "",
        doubleOptIn: true,
      });
    } catch {
      setError("Could not create the list. Check the from address and retry.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(list: SubscriberList) {
    // Deliberately vague about which happens: the server decides based on
    // campaign history, and promising a delete we might not perform would be
    // worse than describing both outcomes.
    if (
      !confirm(
        `Remove "${list.name}"? Lists with campaign history are archived rather than deleted, so their delivery records stay intact.`,
      )
    ) {
      return;
    }
    try {
      await deleteList(list.id);
      const r = await fetchLists({ includeArchived: showArchived });
      setLists(r.items);
    } catch {
      alert("Could not remove this list.");
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Lists"
        subtitle="Subscriber lists, their consent records, and the members campaigns send to."
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90">
                <Plus size={14} />
                New list
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New list</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-text-secondary">
                    Name
                  </span>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
                    placeholder="Weekly digest"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-text-secondary">
                    From address
                  </span>
                  <input
                    required
                    type="email"
                    value={form.fromAddress}
                    onChange={(e) =>
                      setForm({ ...form, fromAddress: e.target.value })
                    }
                    className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
                    placeholder="news@yourdomain.com"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-text-secondary">
                    Description
                  </span>
                  <input
                    value={form.description}
                    onChange={(e) =>
                      setForm({ ...form, description: e.target.value })
                    }
                    className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
                  />
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={form.doubleOptIn}
                    onChange={(e) =>
                      setForm({ ...form, doubleOptIn: e.target.checked })
                    }
                    className="mt-0.5"
                  />
                  <span className="text-xs text-text-secondary">
                    <span className="font-medium text-text-primary">
                      Double opt-in
                    </span>
                    <br />
                    Form signups stay pending until the subscriber confirms by
                    email. Recommended — it is what keeps a typo'd or
                    maliciously-entered address off your list.
                  </span>
                </label>
                {error && <p className="text-xs text-red-600">{error}</p>}
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {saving ? "Creating…" : "Create list"}
                </button>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="max-w-4xl">
        <label className="mb-3 inline-flex items-center gap-2 text-xs text-text-tertiary">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>

        {loading ? (
          <p className="text-sm font-light text-text-tertiary">Loading…</p>
        ) : lists.length === 0 ? (
          <div className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet/10">
              <Users size={20} style={{ color: "#7c5cfc" }} />
            </span>
            <p className="mb-1 text-sm font-medium text-text-primary">
              No lists yet
            </p>
            <p className="text-xs font-light text-text-tertiary">
              A list holds subscribers and the consent record for each one.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <ul className="divide-y divide-border/60">
              {lists.map((list) => (
                <li
                  key={list.id}
                  data-testid="list-row"
                  data-list-id={list.id}
                  className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-text-primary/[0.02]"
                >
                  <Link
                    to={`/lists/${list.id}`}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                      <Users size={14} className="text-text-tertiary" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {list.name}
                        </p>
                        {list.archivedAt !== null && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-muted px-2 py-0.5 text-[10px] font-medium text-text-tertiary">
                            <Archive size={9} />
                            archived
                          </span>
                        )}
                        {list.doubleOptIn && (
                          <span
                            className="inline-flex shrink-0 items-center rounded-full bg-violet/10 px-2 py-0.5 text-[10px] font-medium"
                            style={{ color: "#7c5cfc" }}
                          >
                            double opt-in
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs font-light text-text-tertiary">
                        {list.description || list.fromAddress}
                      </p>
                    </div>
                  </Link>
                  {list.archivedAt === null && (
                    <button
                      onClick={() => handleDelete(list)}
                      className="shrink-0 rounded-[6px] px-2.5 py-1.5 text-xs font-medium text-text-secondary opacity-60 transition-opacity hover:bg-bg-muted group-hover:opacity-100"
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
