import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Send } from "lucide-react";
import {
  createCampaign,
  fetchCampaigns,
  fetchLists,
  fetchTemplates,
  type Campaign,
  type CampaignStatus,
  type SubscriberList,
  type EmailTemplate,
} from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export const STATUS_STYLE: Record<CampaignStatus, string> = {
  draft: "bg-bg-muted text-text-tertiary",
  scheduled: "bg-sky-500/10 text-sky-700",
  overdue: "bg-amber-500/10 text-amber-700",
  preparing: "bg-violet/10 text-violet-700",
  sending: "bg-violet/10 text-violet-700",
  sent: "bg-emerald-500/10 text-emerald-700",
  completed_with_failures: "bg-amber-500/10 text-amber-700",
  cancelled: "bg-bg-muted text-text-tertiary",
  stalled: "bg-red-500/10 text-red-700",
};

export function statusLabel(status: CampaignStatus): string {
  return status.replace(/_/g, " ");
}

export default function CampaignsPage() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [lists, setLists] = useState<SubscriberList[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    subject: "",
    templateSlug: "",
    listId: "",
  });

  useEffect(() => {
    Promise.all([fetchCampaigns(), fetchLists(), fetchTemplates()])
      .then(([c, l, t]) => {
        setCampaigns(c.items);
        setLists(l.items);
        setTemplates(t);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await createCampaign({
        name: form.name.trim(),
        subject: form.subject.trim(),
        // Omitted entirely when blank: sending an empty slug would look like
        // a request to seed from a template named "".
        ...(form.templateSlug ? { templateSlug: form.templateSlug } : {}),
        listId: form.listId,
      });
      setCampaigns((prev) => [created, ...prev]);
      setOpen(false);
      setForm({ name: "", subject: "", templateSlug: "", listId: "" });
      // Straight to the campaign, not back to the list. Creating one is the
      // start of editing it — scheduling, previewing, test-sending all live on
      // the detail page, and bouncing to the list makes every one of those an
      // extra click away from where the operator already is.
      navigate(`/campaigns/${created.id}`);
    } catch {
      setError("Could not create the campaign.");
    } finally {
      setSaving(false);
    }
  }

  // Only a list is required now — content is authored on the campaign.
  const canCreate = lists.length > 0;

  return (
    <PageContainer>
      <PageHeader
        title="Campaigns"
        subtitle="One-off sends to a list. Content is frozen the moment a campaign leaves draft."
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <button
                disabled={!canCreate}
                title={
                  canCreate ? undefined : "A campaign needs at least one list"
                }
                className="inline-flex items-center gap-1.5 rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90 disabled:opacity-50"
              >
                <Plus size={14} />
                New campaign
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New campaign</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-text-secondary">
                    Name
                  </span>
                  <input
                    required
                    aria-label="Campaign name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
                    placeholder="March digest"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-text-secondary">
                    Subject
                  </span>
                  <input
                    required
                    aria-label="Campaign subject"
                    value={form.subject}
                    onChange={(e) =>
                      setForm({ ...form, subject: e.target.value })
                    }
                    className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-text-secondary">
                    List
                  </span>
                  <select
                    required
                    aria-label="Campaign list"
                    value={form.listId}
                    onChange={(e) =>
                      setForm({ ...form, listId: e.target.value })
                    }
                    className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
                  >
                    <option value="">Choose a list…</option>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-text-secondary">
                    Start from
                  </span>
                  <select
                    aria-label="Campaign starting point"
                    value={form.templateSlug}
                    onChange={(e) =>
                      setForm({ ...form, templateSlug: e.target.value })
                    }
                    className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
                  >
                    <option value="">Blank — write it on the campaign</option>
                    {templates.map((t) => (
                      <option key={t.slug} value={t.slug}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[11px] text-text-tertiary">
                    A template is only a starting point — its content is copied
                    in, and you edit it on the campaign afterwards.
                  </span>
                </label>
                {error && <p className="text-xs text-red-600">{error}</p>}
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {saving ? "Creating…" : "Create draft"}
                </button>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="max-w-4xl">
        {loading ? (
          <p className="text-sm font-light text-text-tertiary">Loading…</p>
        ) : campaigns.length === 0 ? (
          <div className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet/10">
              <Send size={20} style={{ color: "#7c5cfc" }} />
            </span>
            <p className="mb-1 text-sm font-medium text-text-primary">
              No campaigns yet
            </p>
            <p className="text-xs font-light text-text-tertiary">
              {canCreate
                ? "Create a draft, preview it, then send when you're ready."
                : "Create a list first."}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <ul className="divide-y divide-border/60">
              {campaigns.map((c) => (
                <li
                  key={c.id}
                  data-testid="campaign-row"
                  data-campaign-id={c.id}
                  className="transition-colors hover:bg-text-primary/[0.02]"
                >
                  <Link
                    to={`/campaigns/${c.id}`}
                    className="flex items-center gap-3 px-5 py-3.5"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                      <Send size={14} className="text-text-tertiary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {c.name}
                        </p>
                        <span
                          className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[c.status]}`}
                        >
                          {statusLabel(c.status)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs font-light text-text-tertiary">
                        {c.subject}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
