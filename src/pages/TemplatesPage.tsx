import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { fetchTemplates, deleteTemplate } from "@/lib/api";
import type { EmailTemplate } from "@/lib/api";

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchTemplates()
      .then(setTemplates)
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(slug: string) {
    if (!confirm("Delete this template?")) return;
    await deleteTemplate(slug);
    setTemplates((prev) => prev.filter((t) => t.slug !== slug));
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-sm font-semibold text-text-primary">
            Email Templates
          </h1>
          <button
            onClick={() => navigate("/templates/new")}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
          >
            New Template
          </button>
        </div>

        {loading ? (
          <p className="text-xs text-text-tertiary">Loading...</p>
        ) : templates.length === 0 ? (
          <p className="text-xs text-text-tertiary">No templates yet.</p>
        ) : (
          <div className="space-y-1">
            {templates.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-lg border border-border-dark bg-card px-4 py-3"
              >
                <div>
                  <p className="text-xs font-medium text-text-primary">
                    {t.name}
                  </p>
                  <p className="text-[11px] text-text-tertiary">
                    {t.slug} &middot; {t.subject}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => navigate(`/templates/${t.slug}/edit`)}
                    className="rounded-md px-2.5 py-1 text-[11px] text-text-secondary hover:bg-hover hover:text-text-primary"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(t.slug)}
                    className="rounded-md px-2.5 py-1 text-[11px] text-destructive hover:bg-hover"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
