import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import HtmlCodeEditor from "@/components/HtmlCodeEditor";
import { fetchTemplate, createTemplate, updateTemplate } from "@/lib/api";

/** Extract {{variableName}} tokens from a string. */
function extractVariables(...sources: string[]): string[] {
  const vars = new Set<string>();
  for (const src of sources) {
    const regex = /\{\{(\w+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(src)) !== null) {
      vars.add(m[1]);
    }
  }
  return Array.from(vars);
}

function ApiSamplePanel({
  slug,
  variables,
  open,
  onClose,
}: {
  slug: string;
  variables: string[];
  open: boolean;
  onClose: () => void;
}) {
  const varsObject = variables.reduce(
    (acc, v) => {
      acc[v] = `<${v}>`;
      return acc;
    },
    {} as Record<string, string>,
  );

  const curlBody = JSON.stringify(
    {
      to: "recipient@example.com",
      variables: variables.length > 0 ? varsObject : undefined,
    },
    null,
    2,
  );

  const curlCommand = `curl -X POST ${window.location.origin}/api/email-templates/${slug || "<slug>"}/send \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <your-api-key>" \\
  -d '${curlBody}'`;

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex">
      <div
        className="fixed inset-0 bg-black/20"
        onClick={onClose}
      />
      <div className="relative w-80 xl:w-96 bg-panel border-l border-border-dark overflow-auto p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-text-primary">
            API Reference
          </h3>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-secondary text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <h4 className="text-xs font-medium text-text-secondary mb-1">
              Endpoint
            </h4>
            <p className="text-[11px] text-text-tertiary font-mono">
              POST /api/email-templates/{slug || "<slug>"}/send
            </p>
          </div>

          {variables.length > 0 && (
            <div>
              <h4 className="text-[11px] font-medium text-text-secondary mb-1.5">
                Required Variables
              </h4>
              <div className="flex flex-wrap gap-1">
                {variables.map((v) => (
                  <span
                    key={v}
                    className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-mono text-accent"
                  >
                    {`{{${v}}}`}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] text-text-tertiary">
                All variables must be provided or the API returns 400.
              </p>
            </div>
          )}

          <div>
            <h4 className="text-[11px] font-medium text-text-secondary mb-1.5">
              Example Request
            </h4>
            <pre className="overflow-x-auto rounded-md bg-sidebar p-3 text-[11px] leading-relaxed text-text-secondary font-mono">
              {curlCommand}
            </pre>
          </div>

          <div>
            <h4 className="text-[11px] font-medium text-text-secondary mb-1.5">
              Error Response
            </h4>
            <pre className="overflow-x-auto rounded-md bg-sidebar p-3 text-[11px] leading-relaxed text-text-secondary font-mono">
              {JSON.stringify(
                {
                  error: "Missing required template variables",
                  missingVariables:
                    variables.length > 0 ? [variables[0]] : [],
                  requiredVariables: variables,
                },
                null,
                2,
              )}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TemplateEditorPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(slug);

  const [name, setName] = useState("");
  const [slugValue, setSlugValue] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(isEdit);
  const [apiPanelOpen, setApiPanelOpen] = useState(false);

  const variables = useMemo(
    () => extractVariables(subject, bodyHtml),
    [subject, bodyHtml],
  );

  useEffect(() => {
    if (slug) {
      fetchTemplate(slug)
        .then((t) => {
          setName(t.name);
          setSlugValue(t.slug);
          setSubject(t.subject);
          setBodyHtml(t.bodyHtml);
        })
        .catch(() => setError("Template not found"))
        .finally(() => setLoading(false));
    }
  }, [slug]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (isEdit) {
        await updateTemplate(slug!, { name, subject, bodyHtml });
      } else {
        await createTemplate({ slug: slugValue, name, subject, bodyHtml });
      }
      navigate("/templates");
    } catch {
      setError("Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-main">
        <p className="text-sm text-text-tertiary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-main overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-border-dark px-4 sm:px-6 py-2.5 bg-panel shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/templates")}
            className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            &larr; Templates
          </button>
          <span className="text-border-dark">/</span>
          <h1 className="text-sm font-semibold text-text-primary">
            {isEdit ? "Edit Template" : "New Template"}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-destructive">{error}</span>}
          <button
            type="button"
            onClick={() => setApiPanelOpen(true)}
            className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          >
            API
          </button>
          <button
            type="button"
            onClick={() => navigate("/templates")}
            className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Template metadata */}
      <div className="shrink-0 w-full px-4 sm:px-6 pt-4 pb-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Untitled Template"
          required
          className="w-full bg-transparent text-2xl font-bold text-text-primary placeholder:text-text-tertiary focus:outline-none mb-3"
        />
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex items-center gap-2 flex-1">
            <label className="text-xs text-text-tertiary shrink-0 w-14">
              Slug
            </label>
            <input
              value={slugValue}
              onChange={(e) => setSlugValue(e.target.value)}
              placeholder="welcome-email"
              pattern="[a-z0-9-]+"
              title="Lowercase letters, numbers, and hyphens only"
              disabled={isEdit}
              required
              className="flex-1 bg-transparent border-b border-transparent hover:border-border-dark focus:border-accent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none py-1 disabled:opacity-50 transition-colors"
            />
          </div>
          <div className="flex items-center gap-2 flex-1">
            <label className="text-xs text-text-tertiary shrink-0 w-14">
              Subject
            </label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Welcome, {{name}}!"
              required
              className="flex-1 bg-transparent border-b border-transparent hover:border-border-dark focus:border-accent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none py-1 transition-colors"
            />
          </div>
        </div>
      </div>

      {/* Variable bar */}
      <div className="shrink-0 px-4 sm:px-6 py-2 border-b border-border-dark">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium">
            Variables
          </span>
          {variables.length > 0 ? (
            <>
              {variables.map((v) => (
                <span
                  key={v}
                  className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-mono text-accent"
                >
                  {`{{${v}}}`}
                </span>
              ))}
              <span className="text-[10px] text-text-tertiary ml-1">
                — use <code className="text-accent/70">{`{{variableName}}`}</code> syntax to add more
              </span>
            </>
          ) : (
            <span className="text-[10px] text-text-tertiary">
              Use <code className="text-accent/70">{`{{variableName}}`}</code> in subject or body to add template variables
            </span>
          )}
        </div>
      </div>

      {/* Split editor: Code + Preview */}
      <div className="flex-1 min-h-0 flex">
        {/* HTML Source */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-border-dark">
          <div className="shrink-0 px-3 py-1.5 border-b border-border-dark bg-panel">
            <span className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium">
              HTML Source
            </span>
          </div>
          <div className="flex-1 min-h-0">
            <HtmlCodeEditor
              value={bodyHtml}
              onChange={setBodyHtml}
            />
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="shrink-0 px-3 py-1.5 border-b border-border-dark bg-panel">
            <span className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium">
              Preview
            </span>
          </div>
          <div className="flex-1 min-h-0">
            <iframe
              title="Email preview"
              sandbox="allow-same-origin"
              srcDoc={bodyHtml}
              className="w-full h-full bg-white"
            />
          </div>
        </div>
      </div>

      {/* API panel (slide-over) */}
      <ApiSamplePanel
        slug={slugValue || slug || ""}
        variables={variables}
        open={apiPanelOpen}
        onClose={() => setApiPanelOpen(false)}
      />
    </div>
  );
}
