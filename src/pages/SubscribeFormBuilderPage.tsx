import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import {
  fetchLists,
  fetchSubscribeForm,
  updateSubscribeForm,
  type SubscribeForm,
  type SubscriberList,
} from "@/lib/api";
import { PageContainer } from "@/components/PageHeader";
import FormSnippet from "@/components/FormSnippet";

export default function SubscribeFormBuilderPage() {
  const { id = "" } = useParams();
  const [form, setForm] = useState<SubscribeForm | null>(null);
  const [lists, setLists] = useState<SubscriberList[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([fetchSubscribeForm(id), fetchLists()])
      .then(([f, l]) => {
        setForm(f);
        setLists(l.items);
      })
      .catch(() => setForm(null))
      .finally(() => setLoading(false));
  }, [id]);

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const next = await updateSubscribeForm(id, {
        name: form.name,
        showNameField: form.showNameField,
        nameRequired: form.nameRequired,
        successMessage: form.successMessage,
        redirectUrl: form.redirectUrl,
        allowedOrigins: form.allowedOrigins,
      });
      // Keep the snippet if the update response omits it, so the panel does
      // not disappear the moment someone renames the form.
      setForm({ embedSnippet: form.embedSnippet, ...next });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <PageContainer>
        <p className="text-sm font-light text-text-tertiary">Loading…</p>
      </PageContainer>
    );
  }

  if (!form) {
    return (
      <PageContainer>
        <p className="text-sm text-text-tertiary">This form doesn't exist.</p>
      </PageContainer>
    );
  }

  const list = lists.find((l) => l.id === form.listId);
  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-secondary">
        {label}
      </span>
      {node}
      {hint && (
        <span className="mt-1 block text-xs text-text-tertiary">{hint}</span>
      )}
    </label>
  );
  const input =
    "w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm";

  return (
    <PageContainer>
      <Link
        to="/subscribe-forms"
        className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-text-tertiary hover:text-text-primary"
      >
        <ChevronLeft size={12} />
        Subscribe forms
      </Link>

      <h1 className="mb-1 text-xl font-semibold tracking-tight text-text-primary">
        {form.name}
      </h1>
      <p className="mb-6 text-sm font-light text-text-tertiary">
        Signs people up to {list?.name ?? "a list"}
        {list?.doubleOptIn
          ? " — submissions stay pending until confirmed by email."
          : " — submissions are subscribed immediately."}
      </p>

      <div className="grid max-w-4xl gap-5 md:grid-cols-2">
        <div className="space-y-4">
          {field(
            "Name",
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={input}
            />,
          )}
          {field(
            "Success message",
            <input
              value={form.successMessage}
              onChange={(e) =>
                setForm({ ...form, successMessage: e.target.value })
              }
              className={input}
            />,
          )}
          {field(
            "Redirect URL",
            <input
              value={form.redirectUrl ?? ""}
              onChange={(e) =>
                setForm({ ...form, redirectUrl: e.target.value || null })
              }
              placeholder="https://yoursite.com/thanks"
              className={input}
            />,
            "Optional. Sent instead of the success message when set.",
          )}
          {field(
            "Allowed origins",
            <input
              value={form.allowedOrigins ?? ""}
              onChange={(e) =>
                setForm({ ...form, allowedOrigins: e.target.value || null })
              }
              placeholder="https://yoursite.com"
              className={input}
            />,
            "Comma-separated. Once set, the check fails closed — a submission from anywhere else is refused rather than allowed through.",
          )}
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={form.showNameField}
              onChange={(e) =>
                setForm({ ...form, showNameField: e.target.checked })
              }
            />
            Ask for a name
          </label>
          {form.showNameField && (
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={form.nameRequired}
                onChange={(e) =>
                  setForm({ ...form, nameRequired: e.target.checked })
                }
              />
              Require it
            </label>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : saved ? "Saved" : "Save"}
          </button>
        </div>

        {form.embedSnippet ? <FormSnippet snippet={form.embedSnippet} /> : null}
      </div>
    </PageContainer>
  );
}
