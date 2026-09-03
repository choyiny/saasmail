import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  Code2,
  GripVertical,
  ListOrdered,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import {
  CodeBlock,
  Field,
  FORM_INPUT_CLASS,
  SectionHeader,
} from "@/components/PageForm";
import {
  fetchSequence,
  fetchTemplates,
  createSequence,
  updateSequence,
  type SequenceStep,
  type EmailTemplate,
} from "@/lib/api";
import { analyzeTemplateClient } from "@/lib/template-syntax";
import { cn } from "@/lib/utils";

/** Round delay-hours into a friendlier string for the summary line. */
function formatDelay(hours: number): string {
  if (hours <= 0) return "immediately";
  if (hours < 24) return `${hours}h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return days === 1 ? "1 day" : `${days} days`;
}

/** Cumulative offset from the enrollment start, e.g. "day 3" for the
 *  third step in a {0, 24h, 72h} sequence. */
function formatCumulative(steps: SequenceStep[], idx: number): string {
  const total = steps
    .slice(0, idx + 1)
    .reduce(
      (acc, s) => acc + (Number.isFinite(s.delayHours) ? s.delayHours : 0),
      0,
    );
  if (total === 0) return "Day 0 · sends right away";
  if (total < 24) return `+${total}h after enrollment`;
  const days = Math.round((total / 24) * 10) / 10;
  return `Day ${days}`;
}

export default function SequenceEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEditing = Boolean(id);

  const [name, setName] = useState("");
  const [steps, setSteps] = useState<SequenceStep[]>([
    { order: 1, templateSlug: "", delayHours: 0 },
  ]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tmpls = await fetchTemplates();
        if (cancelled) return;
        setTemplates(tmpls);
        if (id) {
          const seq = await fetchSequence(id);
          if (cancelled) return;
          setName(seq.name);
          setSteps(seq.steps);
        }
      } catch {
        if (!cancelled) setError("Failed to load sequence.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function addStep() {
    const maxOrder =
      steps.length > 0 ? Math.max(...steps.map((s) => s.order)) : 0;
    setSteps([
      ...steps,
      { order: maxOrder + 1, templateSlug: "", delayHours: 24 },
    ]);
  }

  function removeStep(order: number) {
    if (steps.length <= 1) return;
    setSteps(steps.filter((s) => s.order !== order));
  }

  function updateStep(
    order: number,
    field: keyof SequenceStep,
    value: SequenceStep[keyof SequenceStep],
  ) {
    setSteps(
      steps.map((s) => (s.order === order ? { ...s, [field]: value } : s)),
    );
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!name.trim() || steps.some((s) => !s.templateSlug)) return;
    setSaving(true);
    setError("");
    try {
      if (isEditing && id) {
        await updateSequence(id, { name, steps });
      } else {
        await createSequence({ name, steps });
      }
      navigate("/sequences");
    } catch {
      setError("Failed to save sequence.");
    } finally {
      setSaving(false);
    }
  }

  const totalSteps = steps.length;
  const totalHours = steps.reduce(
    (acc, s) => acc + (Number.isFinite(s.delayHours) ? s.delayHours : 0),
    0,
  );

  if (loading) {
    return (
      <PageContainer>
        <p className="pt-10 text-sm text-text-tertiary">Loading…</p>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Link
        to="/sequences"
        className="-mt-1 mb-1 inline-flex items-center gap-1 text-xs font-medium text-text-tertiary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={12} />
        Sequences
      </Link>

      <PageHeader
        title={isEditing ? name || "Edit sequence" : "New sequence"}
        subtitle={
          isEditing
            ? `${totalSteps} step${totalSteps === 1 ? "" : "s"} · spans ${formatDelay(totalHours)}`
            : "Build a multi-step drip — saasmail schedules each email automatically."
        }
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate("/sequences")}
              className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handleSubmit()}
              disabled={
                saving || !name.trim() || steps.some((s) => !s.templateSlug)
              }
              className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving
                ? "Saving…"
                : isEditing
                  ? "Save changes"
                  : "Create sequence"}
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

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* --- Details card --- */}
        <section className="rounded-[8px] bg-card p-5 ring-1 ring-border">
          <SectionHeader
            icon={Sparkles}
            title="Details"
            subtitle="Give the sequence a clear name — it shows up in the enroll picker."
          />

          <div className="mt-4">
            <Field label="Sequence name" hint="Visible to admins only.">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Welcome onboarding"
                required
                className={FORM_INPUT_CLASS}
              />
            </Field>
          </div>
        </section>

        {/* --- Steps card --- */}
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
            <SectionHeader
              icon={ListOrdered}
              title="Steps"
              subtitle={
                <>
                  {totalSteps} step{totalSteps === 1 ? "" : "s"} · spans{" "}
                  <span className="font-medium text-text-secondary">
                    {formatDelay(totalHours)}
                  </span>{" "}
                  end-to-end. Delay is measured from the previous step.
                </>
              }
            />
          </div>

          <ul
            data-testid="sequence-steps"
            className="divide-y divide-border/60"
          >
            {steps.map((step, idx) => (
              <li
                key={step.order}
                data-testid="sequence-step-row"
                data-step-index={idx}
                className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center"
              >
                <div className="flex shrink-0 items-center gap-2">
                  <GripVertical
                    size={14}
                    className="text-text-tertiary/60"
                    aria-hidden
                  />
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet/10 text-[11px] font-semibold tabular-nums">
                    <span style={{ color: "#7c5cfc" }}>{idx + 1}</span>
                  </span>
                </div>

                <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
                  <Field
                    label="Template"
                    hint={
                      <span className="text-text-tertiary/80">
                        {formatCumulative(steps, idx)}
                      </span>
                    }
                    className="min-w-0"
                  >
                    <select
                      value={step.templateSlug}
                      onChange={(e) =>
                        updateStep(step.order, "templateSlug", e.target.value)
                      }
                      required
                      className={cn(FORM_INPUT_CLASS, "appearance-none pr-8")}
                    >
                      <option value="" disabled>
                        Select a template…
                      </option>
                      {templates.map((t) => (
                        <option key={t.slug} value={t.slug}>
                          {t.name} · {t.slug}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field
                    label="Delay"
                    hint={
                      idx === 0
                        ? "Set 0 so step 1 fires on enrollment."
                        : "Hours after the previous step."
                    }
                    className="sm:w-40"
                  >
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        value={step.delayHours}
                        onChange={(e) =>
                          updateStep(
                            step.order,
                            "delayHours",
                            parseInt(e.target.value, 10) || 0,
                          )
                        }
                        className={cn(FORM_INPUT_CLASS, "pr-12 tabular-nums")}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                        hrs
                      </span>
                    </div>
                  </Field>
                </div>

                <button
                  type="button"
                  onClick={() => removeStep(step.order)}
                  disabled={steps.length <= 1}
                  aria-label="Remove step"
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 self-end rounded-[6px] px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 sm:self-auto"
                >
                  <Trash2 size={12} />
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <div className="border-t border-border bg-bg-subtle/40 px-5 py-3">
            <button
              type="button"
              onClick={addStep}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-dashed border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-text-primary/30 hover:bg-bg-muted hover:text-text-primary"
            >
              <Plus size={12} />
              Add step
            </button>
          </div>
        </section>

        {/* --- API reference (only meaningful for existing sequences) --- */}
        {isEditing && id && (
          <ApiReferenceCard
            sequenceId={id}
            steps={steps}
            templates={templates}
          />
        )}
      </form>
    </PageContainer>
  );
}

/* ---------------------------- API reference card ---------------------------- */

function ApiReferenceCard({
  sequenceId,
  steps,
  templates,
}: {
  sequenceId: string;
  steps: SequenceStep[];
  templates: EmailTemplate[];
}) {
  const [open, setOpen] = useState(false);

  // Walk the templates referenced by the sequence's steps and gather the names
  // a caller must supply. The enrollment endpoint validates these against
  // `variables` on the request body.
  //
  // Analyzed with the shared analyzer, not a `{{(\w+)}}` scan. Once sections
  // existed the regex was inverted from the real contract: it collected
  // `{{price}}` from inside a `{{#items}}` body — which resolves per item and
  // is never required — while missing `{{#items}}` itself, which is. The
  // snippet below is meant to be copied and run, so it advertised names the
  // endpoint ignores and omitted the one it rejects the request for.
  const { allVars, perTemplate, sectionFields } = useMemo(() => {
    const usedSlugs = new Set(steps.map((s) => s.templateSlug).filter(Boolean));
    const usedTemplates = templates.filter((t) => usedSlugs.has(t.slug));
    const all = new Set<string>();
    const per: { slug: string; name: string; vars: string[] }[] = [];
    // Section name -> the names its body references, so the sample payload can
    // show an array of objects instead of a string a section cannot use.
    const sections = new Map<string, string[]>();
    for (const t of usedTemplates) {
      let analysis;
      try {
        analysis = analyzeTemplateClient(t.subject, t.bodyHtml);
      } catch {
        // A template stored before write-time validation may not parse. Skip
        // it rather than dropping the whole snippet.
        continue;
      }
      for (const s of analysis.sections) {
        if (!sections.has(s.name)) sections.set(s.name, s.variables);
      }
      for (const v of analysis.required) all.add(v);
      if (analysis.required.length > 0) {
        per.push({ slug: t.slug, name: t.name, vars: analysis.required });
      }
    }
    return {
      allVars: Array.from(all),
      perTemplate: per,
      sectionFields: sections,
    };
  }, [steps, templates]);

  const varsObj =
    allVars.length > 0
      ? Object.fromEntries(
          allVars.map((v) => {
            const fields = sectionFields.get(v);
            // A required section takes an ARRAY of items. Emitting a string
            // here passes validation and then renders one row with every field
            // blank — the enroll succeeds and the mail is silently wrong.
            if (fields) {
              return [
                v,
                [
                  Object.fromEntries(
                    fields.map((f) => [f, `<${f.toUpperCase()}>`]),
                  ),
                ],
              ];
            }
            return [v, `<${v.toUpperCase()}>`];
          }),
        )
      : undefined;

  const endpoint = `${typeof window !== "undefined" ? window.location.origin : ""}/api/sequences/${sequenceId}/enroll`;

  const body = JSON.stringify(
    {
      personEmail: "<RECIPIENT_EMAIL>",
      fromAddress: "<YOUR_SENDING_ADDRESS>",
      ...(varsObj ? { variables: varsObj } : {}),
    },
    null,
    2,
  );

  const curl = `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`;

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
            Enroll via API
          </h2>
          <p className="mt-0.5 text-xs font-light text-text-secondary">
            Programmatically enroll a contact — pass{" "}
            <code className="rounded bg-bg-muted px-1 py-0.5 font-mono text-[10px]">
              personEmail
            </code>{" "}
            (looked up or created) or{" "}
            <code className="rounded bg-bg-muted px-1 py-0.5 font-mono text-[10px]">
              personId
            </code>{" "}
            (existing).
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
          <Field label="Endpoint">
            <CodeBlock value={`POST ${endpoint}`} oneLine />
          </Field>

          {perTemplate.length > 0 && (
            <Field
              label="Template variables"
              hint="All variables must be supplied in `variables` or the API returns 400."
            >
              <ul className="space-y-1.5 text-xs">
                {perTemplate.map((tv) => (
                  <li
                    key={tv.slug}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="font-medium text-text-primary">
                      {tv.name}
                    </span>
                    <span className="text-text-tertiary">·</span>
                    {tv.vars.map((v) => (
                      <code
                        key={v}
                        className="rounded-full bg-violet/10 px-2 py-0.5 text-[11px] font-mono"
                        style={{ color: "#7c5cfc" }}
                      >
                        {`{{${v}}}`}
                      </code>
                    ))}
                  </li>
                ))}
              </ul>
            </Field>
          )}

          <Field label="Example request">
            <CodeBlock value={curl} />
          </Field>
        </div>
      )}
    </section>
  );
}
