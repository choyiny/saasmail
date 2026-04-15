import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import TiptapEditor from "@/components/TiptapEditor";
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
}: {
  slug: string;
  variables: string[];
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

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-semibold text-text-primary mb-1">
          Send API
        </h3>
        <p className="text-[11px] text-text-tertiary">
          POST /api/email-templates/{slug || "<slug>"}/send
        </p>
      </div>

      {variables.length > 0 && (
        <div>
          <h4 className="text-[11px] font-medium text-text-secondary mb-1">
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
          <p className="mt-1 text-[10px] text-text-tertiary">
            All variables must be provided or the API returns 400.
          </p>
        </div>
      )}

      <div>
        <h4 className="text-[11px] font-medium text-text-secondary mb-1">
          Example Request
        </h4>
        <pre className="overflow-x-auto rounded-md bg-sidebar p-3 text-[11px] leading-relaxed text-text-secondary font-mono">
          {curlCommand}
        </pre>
      </div>

      <div>
        <h4 className="text-[11px] font-medium text-text-secondary mb-1">
          Error Response (missing variables)
        </h4>
        <pre className="overflow-x-auto rounded-md bg-sidebar p-3 text-[11px] leading-relaxed text-text-secondary font-mono">
          {JSON.stringify(
            {
              error: "Missing required template variables",
              missingVariables: variables.length > 0 ? [variables[0]] : [],
              requiredVariables: variables,
            },
            null,
            2,
          )}
        </pre>
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
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-text-tertiary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-border-dark px-4 sm:px-6 py-2.5">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/templates")}
            className="text-xs text-text-tertiary hover:text-text-secondary"
          >
            &larr; Templates
          </button>
          <h1 className="text-sm font-semibold text-text-primary">
            {isEdit ? "Edit Template" : "New Template"}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-destructive">{error}</span>}
          <button
            type="button"
            onClick={() => navigate("/templates")}
            className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Editor column */}
        <div className="flex flex-1 flex-col overflow-auto p-4 sm:p-6 min-w-0">
          <div className="flex flex-col sm:flex-row gap-3 mb-3">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Welcome Email"
                required
                className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <div className="sm:w-48 space-y-1">
              <label className="text-xs font-medium text-text-secondary">
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
                className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              />
            </div>
          </div>

          <div className="mb-3 space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Subject
            </label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Welcome, {{name}}!"
              required
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="flex-1 flex flex-col min-h-0 space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Body
            </label>
            <TiptapEditor
              content={bodyHtml}
              onUpdate={setBodyHtml}
              className="flex-1 min-h-[300px]"
            />
          </div>
        </div>

        {/* API sample panel (desktop only) */}
        <div className="hidden lg:flex w-80 xl:w-96 shrink-0 flex-col overflow-auto border-l border-border-dark bg-panel p-4 sm:p-6">
          <ApiSamplePanel
            slug={slugValue || slug || ""}
            variables={variables}
          />
        </div>
      </div>
    </div>
  );
}
