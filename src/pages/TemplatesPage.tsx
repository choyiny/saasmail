import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, FileText, Pencil, Trash2, Hash, Blocks } from "lucide-react";
import { fetchTemplates, deleteTemplate } from "@/lib/api";
import type { EmailTemplate } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { analyzeTemplateClient } from "@/lib/template-syntax";

/**
 * Count the top-level names a caller can supply — shown as a small badge on
 * each row so the list hints at template complexity without opening the editor.
 *
 * Counted with the shared analyzer rather than a `{{(\w+)}}` scan. The regex
 * was wrong in both directions once sections existed: it counted `{{price}}`
 * inside a `{{#items}}` body, which resolves per item and is not something a
 * caller passes, and it missed `{{#items}}` itself, which is required. A
 * template whose only tags live inside a loop showed a confident, entirely
 * wrong number.
 *
 * Required and optional together, since the badge is about how much a template
 * asks of its caller, not strictly about what would fail a send. A template
 * stored before write-time validation existed may not parse; it counts as 0
 * rather than breaking the list.
 */
function countVariables(t: EmailTemplate): number {
  try {
    const analysis = analyzeTemplateClient(t.subject, t.bodyHtml);
    return new Set([...analysis.required, ...analysis.optional]).size;
  } catch {
    return 0;
  }
}

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
    <PageContainer>
      <PageHeader
        title="Email Templates"
        subtitle="Reusable HTML email templates with {{variable}} interpolation. Send via the UI or API."
        action={
          <div className="flex items-center gap-2">
            {/* Two entry points rather than a format switch inside the editor:
                converting HTML to blocks is refused by the API (the parse would
                be lossy), so the choice belongs at creation time. */}
            <button
              onClick={() => navigate("/templates/new?format=block")}
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-border bg-card px-4 py-2 text-sm font-medium text-text-secondary shadow-sm transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              <Blocks size={14} />
              New block template
            </button>
            <button
              onClick={() => navigate("/templates/new")}
              className="inline-flex items-center gap-1.5 rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90"
            >
              <Plus size={14} />
              New template
            </button>
          </div>
        }
      />

      <div className="max-w-4xl">
        {loading ? (
          <p className="text-sm font-light text-text-tertiary">Loading…</p>
        ) : templates.length === 0 ? (
          <div className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet/10">
              <FileText size={20} style={{ color: "#7c5cfc" }} />
            </span>
            <p className="mb-1 text-sm font-medium text-text-primary">
              No templates yet
            </p>
            <p className="text-xs font-light text-text-tertiary">
              Use the "New template" button above to create your first one.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <ul className="divide-y divide-border/60">
              {templates.map((t) => {
                const varCount = countVariables(t);
                return (
                  <li
                    key={t.id}
                    data-testid="template-row"
                    data-template-name={t.name}
                    data-template-slug={t.slug}
                    className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-text-primary/[0.02]"
                  >
                    <Link
                      to={`/templates/${t.slug}/edit`}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                        <FileText size={14} className="text-text-tertiary" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {t.name}
                          </p>
                          {varCount > 0 && (
                            <span
                              title={`${varCount} variable${varCount === 1 ? "" : "s"}`}
                              className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-violet/10 px-1.5 py-0.5 text-[10px] font-mono"
                              style={{ color: "#7c5cfc" }}
                            >
                              <Hash size={9} />
                              {varCount}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs font-light text-text-tertiary">
                          <span className="font-mono">{t.slug}</span> ·{" "}
                          {t.subject}
                        </p>
                      </div>
                    </Link>
                    <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => navigate(`/templates/${t.slug}/edit`)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                      >
                        <Pencil size={12} />
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(t.slug)}
                        aria-label="Delete"
                        className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
