import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Code2,
  Eye,
  Sparkles,
  Wand2,
} from "lucide-react";
import HtmlCodeEditor from "@/components/HtmlCodeEditor";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import {
  CodeBlock,
  Field,
  FORM_INPUT_CLASS,
  PaneLabel,
  SectionHeader,
} from "@/components/PageForm";
import { fetchTemplate, createTemplate, updateTemplate } from "@/lib/api";
import {
  analyzeTemplateClient,
  sampleValues,
  renderPreview,
  type TemplateAnalysis,
} from "@/lib/template-syntax";
import { cn } from "@/lib/utils";

const EMPTY_ANALYSIS: TemplateAnalysis = {
  required: [],
  optional: [],
  sections: [],
};

/** Lightweight HTML pretty-printer for the "Format" button — adds line
 *  breaks between adjacent tags and indents nested blocks. */
function formatHtml(input: string): string {
  return input
    .replace(/></g, ">\n<")
    .replace(/\n\s*/g, "\n")
    .split("\n")
    .reduce<{ lines: string[]; indent: number }>(
      (acc, line) => {
        const trimmed = line.trim();
        if (!trimmed) return acc;
        const isClosing = /^<\//.test(trimmed);
        const isSelfClosing =
          /\/>$/.test(trimmed) ||
          /^<(br|hr|img|input|meta|link)\b/i.test(trimmed);
        if (isClosing) acc.indent = Math.max(0, acc.indent - 1);
        acc.lines.push("  ".repeat(acc.indent) + trimmed);
        if (!isClosing && !isSelfClosing && /^<[^/!]/.test(trimmed))
          acc.indent++;
        return acc;
      },
      { lines: [], indent: 0 },
    )
    .lines.join("\n");
}

type ViewMode = "split" | "code" | "preview";

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
  const [viewMode, setViewMode] = useState<ViewMode>("split");

  // A section left open mid-keystroke (e.g. typing "{{#items}}" before its
  // closing tag) is a normal, transient state, not a bug — fall back to an
  // empty analysis rather than crashing the page on every keystroke.
  const analysis = useMemo(() => {
    try {
      return analyzeTemplateClient(subject, bodyHtml);
    } catch {
      return EMPTY_ANALYSIS;
    }
  }, [subject, bodyHtml]);
  const variables = analysis.required;

  const previewHtml = useMemo(() => {
    try {
      return renderPreview(bodyHtml, sampleValues(analysis));
    } catch {
      // Unbalanced sections mid-edit are normal — show the source instead.
      return bodyHtml;
    }
  }, [bodyHtml, analysis]);

  useEffect(() => {
    if (!slug) return;
    fetchTemplate(slug)
      .then((t) => {
        setName(t.name);
        setSlugValue(t.slug);
        setSubject(t.subject);
        setBodyHtml(t.bodyHtml);
      })
      .catch(() => setError("Template not found"))
      .finally(() => setLoading(false));
  }, [slug]);

  async function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
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
      <PageContainer>
        <p className="pt-10 text-sm text-text-tertiary">Loading…</p>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Breadcrumb back-link, sits above the page header. */}
      <Link
        to="/templates"
        className="-mt-1 mb-1 inline-flex items-center gap-1 text-xs font-medium text-text-tertiary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={12} />
        Templates
      </Link>

      <PageHeader
        title={isEdit ? name || "Edit template" : "New template"}
        subtitle={
          isEdit && slugValue ? (
            <span className="font-mono">{slugValue}</span>
          ) : (
            "Reusable HTML email with {{variable}} interpolation."
          )
        }
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate("/templates")}
              className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handleSave()}
              disabled={saving}
              className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create template"}
            </button>
          </div>
        }
      />

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-[8px] border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-5">
        {/* --- Details card --- */}
        <section className="rounded-[8px] bg-card p-5 ring-1 ring-border">
          <SectionHeader
            icon={Sparkles}
            title="Details"
            subtitle="The template's identity. Slug is the stable id used by the API and sequences."
          />

          <div className="mt-4 space-y-4">
            <Field label="Name" hint="Shown in the template picker.">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Welcome email"
                required
                className={FORM_INPUT_CLASS}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Slug"
                hint={
                  isEdit
                    ? "Slug can't change once a template is created."
                    : "Lowercase letters, numbers, hyphens."
                }
              >
                <input
                  value={slugValue}
                  onChange={(e) => setSlugValue(e.target.value)}
                  placeholder="welcome-email"
                  pattern="[a-z0-9-]+"
                  title="Lowercase letters, numbers, and hyphens only"
                  disabled={isEdit}
                  required
                  className={cn(
                    FORM_INPUT_CLASS,
                    "font-mono",
                    isEdit && "opacity-60",
                  )}
                />
              </Field>

              <Field
                label="Subject line"
                hint={
                  <>
                    Use{" "}
                    <code className="rounded bg-bg-muted px-1 py-0.5 font-mono text-[10px]">
                      {`{{variable}}`}
                    </code>{" "}
                    for placeholders. Plain text here, not HTML — values are
                    substituted unescaped, unlike the body.
                  </>
                }
              >
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Welcome, {{name}}!"
                  required
                  className={FORM_INPUT_CLASS}
                />
              </Field>
            </div>
          </div>
        </section>

        {/* --- Body card with HTML editor + live preview --- */}
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0">
              <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                <Code2 size={13} className="text-text-tertiary" />
                Body
              </h2>
              <p className="mt-0.5 text-xs font-light text-text-secondary">
                Author HTML on the left, see the rendered email on the right.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ViewToggle mode={viewMode} onChange={setViewMode} />
              <button
                type="button"
                onClick={() => setBodyHtml(formatHtml(bodyHtml))}
                disabled={!bodyHtml}
                className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Wand2 size={11} />
                Format
              </button>
            </div>
          </div>

          {/* Inline auto-detected variables, grouped by contract: required
              names fail the send if missing, optional ones render empty,
              and sections need an array/object rather than a plain value.
              Blank when none, so the strip doesn't take space until
              something useful shows up. */}
          {(analysis.required.length > 0 ||
            analysis.optional.length > 0 ||
            analysis.sections.length > 0) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-subtle/40 px-5 py-2.5">
              <VarGroup
                label="Required"
                // Section names get their own accurate chip (with the right
                // sigil) in the Sections group below — showing them again
                // here as bare `{{name}}` would be a string that never
                // actually appears in the template.
                items={analysis.required
                  .filter((v) => !isSectionName(analysis, v))
                  .map((v) => ({ name: v, label: `{{${v}}}` }))}
                className="bg-violet/10 text-[#7c5cfc]"
              />
              <VarGroup
                label="Optional"
                // Same exclusion: an inverted or `?`-marked section lands in
                // `analysis.optional` too, but its optionality is already
                // shown correctly (as ^ or #...?) in the Sections chip.
                items={analysis.optional
                  .filter((v) => !isSectionName(analysis, v))
                  .map((v) => ({ name: v, label: `{{${v}?}}` }))}
                className="bg-bg-muted text-text-secondary"
              />
              <VarGroup
                label="Sections"
                items={analysis.sections.map((s) => ({
                  name: s.name,
                  label: sectionChipLabel(s, analysis),
                }))}
                className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              />
            </div>
          )}

          <div className="grid h-[520px] grid-cols-1 md:grid-cols-2">
            {/* HTML editor */}
            {viewMode !== "preview" && (
              <div
                className={cn(
                  "flex min-w-0 flex-col",
                  viewMode === "split" &&
                    "border-b border-border md:border-b-0 md:border-r",
                  viewMode === "code" && "md:col-span-2",
                )}
              >
                <PaneLabel>HTML source</PaneLabel>
                <div className="min-h-0 flex-1">
                  <HtmlCodeEditor value={bodyHtml} onChange={setBodyHtml} />
                </div>
              </div>
            )}

            {/* Live preview */}
            {viewMode !== "code" && (
              <div
                className={cn(
                  "flex min-w-0 flex-col",
                  viewMode === "preview" && "md:col-span-2",
                )}
              >
                <PaneLabel>Preview</PaneLabel>
                <div className="min-h-0 flex-1 bg-white">
                  <iframe
                    title="Email preview"
                    sandbox="allow-same-origin"
                    srcDoc={previewHtml}
                    className="h-full w-full"
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* --- Syntax & styling reference (collapsible) --- */}
        <SyntaxCard />

        {/* --- API reference (collapsible, no longer a slide-over) --- */}
        <ApiReferenceCard
          slug={slugValue || slug || ""}
          variables={variables}
        />
      </form>
    </PageContainer>
  );
}

/* --------------------------------- helpers --------------------------------- */

interface ViewToggleProps {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}

function ViewToggle({ mode, onChange }: ViewToggleProps) {
  return (
    <div className="inline-flex rounded-[6px] bg-bg-muted/70 p-0.5 ring-1 ring-border">
      <ToggleButton
        active={mode === "code"}
        onClick={() => onChange("code")}
        icon={Code2}
        label="Code"
      />
      <ToggleButton
        active={mode === "split"}
        onClick={() => onChange("split")}
        icon={Sparkles}
        label="Split"
      />
      <ToggleButton
        active={mode === "preview"}
        onClick={() => onChange("preview")}
        icon={Eye}
        label="Preview"
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-[11px] font-medium transition-all",
        active
          ? "bg-card text-text-primary shadow-sm"
          : "text-text-secondary hover:text-text-primary",
      )}
    >
      <Icon size={11} />
      {label}
    </button>
  );
}

/* ------------------------------- variable chips ------------------------------- */

/** Whether `name` belongs to a section, so plain-variable groups can skip it
 *  — a section already gets its own chip with the correct sigil below. */
function isSectionName(analysis: TemplateAnalysis, name: string): boolean {
  return analysis.sections.some((s) => s.name === name);
}

/**
 * The exact tag text for a section's chip. Must always be a string that
 * really appears in the template — never a syntax that contradicts it:
 *   - inverted (`{{^key}}`) always renders that way, `?` or not, since
 *     inversion alone already makes it optional.
 *   - a non-inverted section that's optional (`analysis.optional` includes
 *     it) got there via a trailing `?`, so it renders as `{{#key?}}`.
 *   - otherwise it's a plain required section, `{{#key}}`.
 */
function sectionChipLabel(
  section: TemplateAnalysis["sections"][number],
  analysis: TemplateAnalysis,
): string {
  if (section.inverted) return `{{^${section.name}}}`;
  if (analysis.optional.includes(section.name)) return `{{#${section.name}?}}`;
  return `{{#${section.name}}}`;
}

function VarGroup({
  label,
  items,
  className,
}: {
  label: string;
  items: Array<{ name: string; label: string }>;
  className: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
        {label}
      </span>
      {items.map((item) => (
        <code
          key={item.name}
          className={cn(
            "rounded-full px-2 py-0.5 font-mono text-[11px]",
            className,
          )}
        >
          {item.label}
        </code>
      ))}
    </div>
  );
}

/* --------------------------- syntax & styling card --------------------------- */

const SYNTAX_ROWS: Array<{ tag: string; meaning: string }> = [
  {
    tag: "{{key}}",
    meaning:
      "Value, HTML-escaped in the body. The subject is plain text, so it's substituted unescaped there.",
  },
  {
    tag: "{{{key}}}",
    meaning: "Value, raw. Only for HTML you generated yourself.",
  },
  {
    tag: "{{key?}}",
    meaning: "Optional — renders empty instead of failing the send.",
  },
  { tag: "{{key|nl2br}}", meaning: "Escaped, then newlines become <br>." },
  {
    tag: "{{#key}}…{{/key}}",
    meaning: "Renders if truthy; repeats for each item in an array.",
  },
  {
    tag: "{{#key?}}…{{/key}}",
    meaning: "Same as {{#key}}, but doesn't fail the send if missing.",
  },
  {
    tag: "{{^key}}…{{/key}}",
    meaning: "Renders only if the value is missing or empty.",
  },
  {
    tag: "{{.}}",
    meaning: "The current item, inside a list of plain strings.",
  },
];

const LOOP_SNIPPET = `<table>
  {{#items}}
    <tr>
      <td>{{label}}</td>
      <td>{{currency}}{{price}}</td>
    </tr>
  {{/items}}
</table>
{{^items}}
  <p>Nothing to show yet.</p>
{{/items}}`;

const MULTILINE_SNIPPET = `<div style="white-space: pre-line">
  {{message}}
</div>`;

function SyntaxCard() {
  const [open, setOpen] = useState(false);
  return (
    <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-bg-muted/30"
      >
        <div className="min-w-0">
          <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary">
            <BookOpen size={13} className="text-text-tertiary" />
            Syntax &amp; styling
          </h2>
          <p className="mt-0.5 text-xs font-light text-text-secondary">
            Every tag you can use, and the styles worth knowing about.
          </p>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            "shrink-0 text-text-tertiary transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="space-y-5 border-t border-border px-5 py-5">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <tbody>
                {SYNTAX_ROWS.map((row) => (
                  <tr
                    key={row.tag}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="whitespace-nowrap py-2 pr-4 align-top">
                      <code className="rounded bg-bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {row.tag}
                      </code>
                    </td>
                    <td className="py-2 font-light text-text-secondary">
                      {row.meaning}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Field
            label="Lists and empty states"
            hint="Names inside a section match the item first, then fall back to the top level — so {{currency}} can live outside {{#items}}."
          >
            <CodeBlock value={LOOP_SNIPPET} />
          </Field>

          <Field
            label="Multi-line values"
            hint="HTML collapses newlines to spaces. Use {{message|nl2br}}, or keep the line breaks with a style on the wrapping block."
          >
            <CodeBlock value={MULTILINE_SNIPPET} />
          </Field>

          <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-light text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <strong className="font-medium">Escaped by default.</strong> A value
            containing HTML renders as visible text, so content typed by your
            users can't inject markup into an email signed by your domain. Use{" "}
            <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-500/20">
              {`{{{key}}}`}
            </code>{" "}
            only for HTML your own code produced.
          </div>

          <div className="rounded-[6px] border border-border bg-bg-subtle/50 px-3 py-2.5 text-xs font-light text-text-secondary">
            <strong className="font-medium text-text-primary">
              Adding a variable affects live senders.
            </strong>{" "}
            A new{" "}
            <code className="rounded bg-bg-muted px-1 font-mono">{`{{key}}`}</code>{" "}
            takes effect the moment you save, and callers that don't send it
            start failing with 400. Deploy the caller first, or mark it optional
            with{" "}
            <code className="rounded bg-bg-muted px-1 font-mono">{`{{key?}}`}</code>
            .
          </div>
        </div>
      )}
    </section>
  );
}

/* ----------------------------- API reference card ----------------------------- */

function ApiReferenceCard({
  slug,
  variables,
}: {
  slug: string;
  variables: string[];
}) {
  const [open, setOpen] = useState(false);

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
      ...(variables.length > 0 ? { variables: varsObject } : {}),
    },
    null,
    2,
  );

  const endpoint = `${typeof window !== "undefined" ? window.location.origin : ""}/api/email-templates/${slug || "<slug>"}/send`;
  const curlCommand = `curl -X POST ${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <your-api-key>" \\
  -d '${curlBody}'`;

  const errorBody = JSON.stringify(
    {
      error: "Missing required template variables",
      missingVariables: variables.length > 0 ? [variables[0]] : [],
      requiredVariables: variables,
    },
    null,
    2,
  );

  return (
    <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-bg-muted/30"
      >
        <div className="min-w-0">
          <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary">
            <Code2 size={13} className="text-text-tertiary" />
            Send via API
          </h2>
          <p className="mt-0.5 text-xs font-light text-text-secondary">
            Trigger this template from your backend with a single authenticated
            POST.
          </p>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            "shrink-0 text-text-tertiary transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="space-y-5 border-t border-border px-5 py-5">
          <Field label="Endpoint" hint="POST to this URL with a JSON body.">
            <CodeBlock value={`POST ${endpoint}`} oneLine />
          </Field>

          {variables.length > 0 && (
            <Field
              label="Required variables"
              hint="All variables must be provided in the request body or the API returns 400."
            >
              <div className="flex flex-wrap gap-1.5">
                {variables.map((v) => (
                  <code
                    key={v}
                    className="rounded-full bg-violet/10 px-2 py-0.5 text-[11px] font-mono"
                    style={{ color: "#7c5cfc" }}
                  >
                    {`{{${v}}}`}
                  </code>
                ))}
              </div>
            </Field>
          )}

          <Field label="Example request">
            <CodeBlock value={curlCommand} />
          </Field>

          <Field label="Error response (400)">
            <CodeBlock value={errorBody} />
          </Field>
        </div>
      )}
    </section>
  );
}
