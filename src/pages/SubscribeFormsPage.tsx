import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ClipboardList, Plus } from "lucide-react";
import {
  createSubscribeForm,
  deleteSubscribeForm,
  fetchLists,
  fetchSubscribeForms,
  type SubscribeForm,
  type SubscriberList,
} from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";

export default function SubscribeFormsPage() {
  const [forms, setForms] = useState<SubscribeForm[]>([]);
  const [lists, setLists] = useState<SubscriberList[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([fetchSubscribeForms(), fetchLists()])
      .then(([f, l]) => {
        setForms(f.items);
        setLists(l.items);
      })
      .finally(() => setLoading(false));
  }, []);

  const listName = (id: string) =>
    lists.find((l) => l.id === id)?.name ?? "unknown list";

  async function handleCreate() {
    if (lists.length === 0) return;
    const created = await createSubscribeForm({
      listId: lists[0].id,
      name: "New form",
    });
    navigate(`/subscribe-forms/${created.id}`);
  }

  async function handleDelete(form: SubscribeForm) {
    if (!confirm(`Delete "${form.name}"? Existing members are unaffected.`)) {
      return;
    }
    await deleteSubscribeForm(form.id);
    setForms((prev) => prev.filter((f) => f.id !== form.id));
  }

  return (
    <PageContainer>
      <PageHeader
        title="Subscribe forms"
        subtitle="Public signup endpoints for your own site, with honeypot, rate limiting and an origin check in front of each."
        action={
          <button
            onClick={handleCreate}
            disabled={lists.length === 0}
            title={lists.length === 0 ? "Create a list first" : undefined}
            className="inline-flex items-center gap-1.5 rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90 disabled:opacity-50"
          >
            <Plus size={14} />
            New form
          </button>
        }
      />

      <div className="max-w-4xl">
        {loading ? (
          <p className="text-sm font-light text-text-tertiary">Loading…</p>
        ) : forms.length === 0 ? (
          <div className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet/10">
              <ClipboardList size={20} style={{ color: "#7c5cfc" }} />
            </span>
            <p className="mb-1 text-sm font-medium text-text-primary">
              No subscribe forms yet
            </p>
            <p className="text-xs font-light text-text-tertiary">
              {lists.length === 0
                ? "Create a list first — a form points at one."
                : "A form gives you an HTML snippet to paste on your own site."}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <ul className="divide-y divide-border/60">
              {forms.map((form) => (
                <li
                  key={form.id}
                  data-testid="form-row"
                  className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-text-primary/[0.02]"
                >
                  <Link
                    to={`/subscribe-forms/${form.id}`}
                    className="flex min-w-0 flex-1 items-center gap-3"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                      <ClipboardList size={14} className="text-text-tertiary" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {form.name}
                      </p>
                      <p className="mt-0.5 truncate text-xs font-light text-text-tertiary">
                        signs up to {listName(form.listId)}
                        {form.allowedOrigins
                          ? ` · ${form.allowedOrigins}`
                          : " · any origin"}
                      </p>
                    </div>
                  </Link>
                  <button
                    onClick={() => handleDelete(form)}
                    className="shrink-0 rounded-[6px] px-2.5 py-1.5 text-xs font-medium text-text-secondary opacity-60 hover:bg-bg-muted group-hover:opacity-100"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
