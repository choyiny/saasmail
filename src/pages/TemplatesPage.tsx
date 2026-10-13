import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, FileText, Pencil, Trash2, Hash, Blocks } from "lucide-react";
import { fetchTemplates, deleteTemplate } from "@/lib/api";
import type { EmailTemplate } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
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
        title="Email templates"
        subtitle="Reusable HTML emails with {{variable}} interpolation. Send from the app or the API."
        action={
          <div className="flex items-center gap-2">
            {/* Two entry points rather than a format switch inside the editor:
                converting HTML to blocks is refused by the API (the parse would
                be lossy), so the choice belongs at creation time. */}
            <Button
              variant="outline"
              onClick={() => navigate("/templates/new?format=block")}
            >
              <Blocks />
              New block template
            </Button>
            <Button onClick={() => navigate("/templates/new")}>
              <Plus />
              New template
            </Button>
          </div>
        }
      />

      <div>
        {loading ? (
          <div
            className="pt-card divide-y divide-border-subtle"
            aria-busy="true"
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-4">
                <span className="pt-skel h-9 w-9 rounded-lg" />
                <span className="flex flex-1 flex-col gap-2">
                  <span className="pt-skel h-3 w-1/3" />
                  <span className="pt-skel h-2.5 w-1/2" />
                </span>
              </div>
            ))}
          </div>
        ) : templates.length === 0 ? (
          <div className="pt-card pt-empty">
            <span className="ic">
              <FileText size={18} />
            </span>
            <p>
              No templates yet. Create one to reuse it from the composer,
              sequences or the API.
            </p>
            <Button
              variant="outline"
              onClick={() => navigate("/templates/new")}
            >
              <Plus />
              Create a template
            </Button>
          </div>
        ) : (
          <div className="pt-card overflow-hidden">
            <div className="hidden h-9 items-center gap-4 border-b border-border bg-bg-subtle px-5 sm:flex">
              <span className="font-label flex-1 text-text-secondary">
                Template
              </span>
              <span className="font-label w-24 text-right text-text-secondary">
                Variables
              </span>
              <span className="w-[104px]" />
            </div>
            <ul className="divide-y divide-border-subtle">
              {templates.map((t) => {
                const varCount = countVariables(t);
                return (
                  <li
                    key={t.id}
                    data-testid="template-row"
                    data-template-name={t.name}
                    data-template-slug={t.slug}
                    className="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-bg-subtle sm:gap-4 sm:px-5"
                  >
                    <Link
                      to={`/templates/${t.slug}/edit`}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-subtle">
                        <FileText size={15} className="text-text-secondary" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-medium text-text-primary">
                          {t.name}
                        </p>
                        <p className="truncate text-[13px] text-text-secondary">
                          <span className="font-code text-xs text-text-tertiary">
                            {t.slug}
                          </span>
                          <span className="text-text-tertiary"> · </span>
                          {t.subject}
                        </p>
                      </div>
                    </Link>
                    <span className="hidden w-24 justify-end sm:flex">
                      {varCount > 0 ? (
                        <span
                          title={`${varCount} variable${varCount === 1 ? "" : "s"}`}
                          className="pt-chip accent tabular"
                        >
                          <Hash />
                          {varCount}
                        </span>
                      ) : (
                        <span className="text-[13px] text-text-tertiary">
                          —
                        </span>
                      )}
                    </span>
                    <div className="flex shrink-0 items-center justify-end sm:w-[104px] gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/templates/${t.slug}/edit`)}
                      >
                        <Pencil />
                        <span className="max-sm:sr-only">Edit</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(t.slug)}
                        aria-label="Delete"
                        className="h-8 w-8 hover:bg-destructive-subtle hover:text-destructive"
                      >
                        <Trash2 />
                      </Button>
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
