import { useState, useEffect, useMemo } from "react";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
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
  chipLabel,
  isSectionName,
  renderPreview,
  sampleValues,
  sectionChipLabel,
  type TemplateAnalysis,
} from "@/lib/template-syntax";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

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
  // What was last loaded or saved, to tell when there are unsaved edits.
  const [saved, setSaved] = useState(() =>
    JSON.stringify({ name: "", slugValue: "", subject: "", bodyHtml: "" }),
  );
  const dirty =
    !loading &&
    JSON.stringify({ name, slugValue, subject, bodyHtml }) !== saved;
  const { confirmLeave, release } = useUnsavedGuard(dirty);

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
        setSaved(
          JSON.stringify({
            name: t.name,
            slugValue: t.slug,
            subject: t.subject,
            bodyHtml: t.bodyHtml,
          }),
        );
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
      release();
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
        <div className="flex flex-col gap-4" aria-busy="true">
          <span className="pt-skel h-6 w-48" />
          <span className="pt-skel h-40 w-full rounded-2xl" />
          <span className="pt-skel h-[420px] w-full rounded-2xl" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Breadcrumb back-link, sits above the page header. */}
      <Link
        to="/templates"
        className="-mt-1 mb-2 inline-flex items-center gap-1 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={14} />
        Templates
      </Link>

      <PageHeader
        title={isEdit ? name || "Edit template" : "New template"}
        subtitle={
          isEdit && slugValue ? (
            <span className="font-code text-xs">{slugValue}</span>
          ) : (
            "Reusable HTML email with {{variable}} interpolation."
          )
        }
        action={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => confirmLeave() && navigate("/templates")}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => handleSave()}
              disabled={saving}
            >
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create template"}
            </Button>
          </div>
        }
      />

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-destructive/25 bg-destructive-subtle px-4 py-2.5 text-[13px] text-destructive"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-5">
        {/* --- Details card --- */}
        <section className="pt-card p-5">
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
                    "font-code",
                    isEdit && "opacity-60",
                  )}
                />
              </Field>

              <Field
                label="Subject line"
                hint={
                  <>
                    Use{" "}
                    <code className="font-code rounded bg-bg-muted px-1 py-0.5 text-[11px]">
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
        <section className="pt-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0">
              <h2 className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-text-primary">
                <Code2 size={15} className="text-text-secondary" />
                Body
              </h2>
              <p className="mt-0.5 text-[13px] text-text-secondary">
                Author HTML on the left, see the rendered email on the right.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ViewToggle mode={viewMode} onChange={setViewMode} />
              <button
                type="button"
                onClick={() => setBodyHtml(formatHtml(bodyHtml))}
                disabled={!bodyHtml}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-card px-2.5 text-[13px] font-medium text-text-primary shadow-card ring-1 ring-inset ring-border-strong transition-colors hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Wand2 size={14} className="text-text-secondary" />
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
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-subtle px-5 py-2.5">
              <VarGroup
                label="Required"
                // Section names get their own accurate chip (with the right
                // sigil) in the Sections group below — showing them again
                // here as bare `{{name}}` would be a string that never
                // actually appears in the template.
                items={analysis.required
                  .filter((v) => !isSectionName(analysis, v))
                  .map((v) => ({ name: v, label: `{{${v}}}` }))}
                className="accent"
              />
              <VarGroup
                label="Optional"
                // Same exclusion: an inverted or `?`-marked section lands in
                // `analysis.optional` too, but its optionality is already
                // shown correctly (as ^ or #...?) in the Sections chip.
                items={analysis.optional
                  .filter((v) => !isSectionName(analysis, v))
                  .map((v) => ({ name: v, label: `{{${v}?}}` }))}
                className=""
              />
              <VarGroup
                label="Sections"
                items={analysis.sections.map((s) => ({
                  name: s.name,
                  label: sectionChipLabel(s, analysis),
                }))}
                className="ok"
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
                <div className="email-surface min-h-0 flex-1 !rounded-none !shadow-none">
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
        <ApiReferenceCard slug={slugValue || slug || ""} analysis={analysis} />
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
    <div className="pt-seg" role="group" aria-label="Editor view">
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
      aria-pressed={active}
      className={cn(active && "on")}
    >
      <Icon />
      {label}
    </button>
  );
}

/* ------------------------------- variable chips ------------------------------- */

/** Whether `name` belongs to a section, so plain-variable groups can skip it
 *  — a section already gets its own chip with the correct sigil below. */
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
      <span className="font-label text-[10.5px] text-text-tertiary">
        {label}
      </span>
      {items.map((item) => (
        <code
          key={item.name}
          className={cn("pt-chip font-code !font-medium", className)}
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
    <section className="pt-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-bg-subtle"
      >
        <div className="min-w-0">
          <h2 className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-text-primary">
            <BookOpen size={15} className="text-text-secondary" />
            Syntax &amp; styling
          </h2>
          <p className="mt-0.5 text-[13px] text-text-secondary">
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
            <table className="w-full text-left text-[13px]">
              <tbody>
                {SYNTAX_ROWS.map((row) => (
                  <tr
                    key={row.tag}
                    className="border-b border-border-subtle last:border-0"
                  >
                    <td className="whitespace-nowrap py-2 pr-4 align-top">
                      <code className="font-code rounded-md bg-bg-muted px-1.5 py-0.5 text-xs text-text-primary">
                        {row.tag}
                      </code>
                    </td>
                    <td className="py-2 text-text-secondary">{row.meaning}</td>
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

          <div className="rounded-xl border border-warning-border bg-warning-bg px-3.5 py-3 text-[13px] text-text-primary">
            <strong className="font-semibold text-warning">
              Escaped by default.
            </strong>{" "}
            A value containing HTML renders as visible text, so it can't
            introduce tags into an email signed by your domain. Use{" "}
            <code className="font-code rounded bg-card/60 px-1">
              {`{{{key}}}`}
            </code>{" "}
            only for HTML your own code produced.
            <div className="mt-1.5">
              Escaping covers <code className="font-code">{`& < > " '`}</code>{" "}
              only — it is not a URL check. Keep every attribute quoted (
              <code className="font-code">{`href="{{url}}"`}</code>, never{" "}
              <code className="font-code">{`href={{url}}`}</code>), and don't
              put an untrusted value in an{" "}
              <code className="font-code">href</code> without checking its
              scheme: <code className="font-code">javascript:</code> passes
              through.
            </div>
          </div>

          <div className="rounded-xl border border-border bg-bg-subtle px-3.5 py-3 text-[13px] text-text-secondary">
            <strong className="font-semibold text-text-primary">
              Adding a variable affects live senders.
            </strong>{" "}
            A new{" "}
            <code className="font-code rounded bg-bg-muted px-1">{`{{key}}`}</code>{" "}
            takes effect the moment you save, and callers that don't send it
            start failing with 400. Deploy the caller first, or mark it optional
            with{" "}
            <code className="font-code rounded bg-bg-muted px-1">{`{{key?}}`}</code>
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
  analysis,
}: {
  slug: string;
  analysis: TemplateAnalysis;
}) {
  const [open, setOpen] = useState(false);
  const variables = analysis.required;

  // A required section name takes an ARRAY of items, not a string. Emitting
  // `"items": "<items>"` here would have the reader send a scalar, which
  // passes validation and then renders one row with every field blank — the
  // send succeeds and the email is silently wrong. (A required section is
  // always non-inverted; an inverted one is optional by definition.)
  const sectionsByName = new Map(analysis.sections.map((s) => [s.name, s]));
  const varsObject = variables.reduce(
    (acc, v) => {
      const section = sectionsByName.get(v);
      acc[v] = section
        ? [
            Object.fromEntries(
              section.variables.map((inner) => [inner, `<${inner}>`]),
            ),
          ]
        : `<${v}>`;
      return acc;
    },
    {} as Record<string, unknown>,
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
    <section className="pt-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-bg-subtle"
      >
        <div className="min-w-0">
          <h2 className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-text-primary">
            <Code2 size={15} className="text-text-secondary" />
            Send via API
          </h2>
          <p className="mt-0.5 text-[13px] text-text-secondary">
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
                    className="pt-chip accent font-code !font-medium"
                  >
                    {chipLabel(v, analysis)}
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
