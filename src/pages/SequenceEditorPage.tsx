import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  fetchSequence,
  fetchTemplates,
  createSequence,
  updateSequence,
  type SequenceStep,
  type EmailTemplate,
} from "@/lib/api";

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

  useEffect(() => {
    const load = async () => {
      const tmpls = await fetchTemplates();
      setTemplates(tmpls);

      if (id) {
        const seq = await fetchSequence(id);
        setName(seq.name);
        setSteps(seq.steps);
      }
      setLoading(false);
    };
    load();
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

  function updateStep(order: number, field: keyof SequenceStep, value: any) {
    setSteps(
      steps.map((s) => (s.order === order ? { ...s, [field]: value } : s)),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || steps.some((s) => !s.templateSlug)) return;

    setSaving(true);
    try {
      if (isEditing && id) {
        await updateSequence(id, { name, steps });
      } else {
        await createSequence({ name, steps });
      }
      navigate("/sequences");
    } catch (err) {
      alert("Failed to save sequence.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex-1 p-6">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="mb-6 text-xl font-semibold text-text-primary">
        {isEditing ? "Edit Sequence" : "New Sequence"}
      </h1>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-text-secondary">
            Sequence Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Welcome Sequence"
            className="w-full rounded-md border border-border bg-white ring-1 ring-gray-200 px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none"
            required
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-text-secondary">
            Steps
          </label>
          <div className="space-y-3">
            {steps.map((step, idx) => (
              <div
                key={step.order}
                className="flex items-center gap-3 rounded-lg border border-border bg-white ring-1 ring-gray-200 p-3"
              >
                <span className="text-xs font-medium text-text-tertiary">
                  #{idx + 1}
                </span>
                <select
                  value={step.templateSlug}
                  onChange={(e) =>
                    updateStep(step.order, "templateSlug", e.target.value)
                  }
                  className="flex-1 rounded-md border border-border bg-white ring-1 ring-gray-200 px-2 py-1.5 text-sm text-text-primary"
                  required
                >
                  <option value="">Select template...</option>
                  {templates.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    value={step.delayHours}
                    onChange={(e) =>
                      updateStep(
                        step.order,
                        "delayHours",
                        parseInt(e.target.value) || 0,
                      )
                    }
                    className="w-20 rounded-md border border-border bg-white ring-1 ring-gray-200 px-2 py-1.5 text-sm text-text-primary"
                  />
                  <span className="text-xs text-text-tertiary">hrs delay</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeStep(step.order)}
                  className="text-xs text-red-400 hover:text-red-300"
                  disabled={steps.length <= 1}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addStep}
            className="mt-2 text-xs text-accent hover:underline"
          >
            + Add step
          </button>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? "Saving..." : isEditing ? "Update" : "Create"}
          </button>
          <button
            type="button"
            onClick={() => navigate("/sequences")}
            className="rounded-md border border-border px-4 py-2 text-sm text-text-secondary hover:bg-bg-muted"
          >
            Cancel
          </button>
        </div>
      </form>

      {/* API usage example (only shown when editing an existing sequence) */}
      {isEditing && id && (
        <div className="mt-8 max-w-2xl">
          <h2 className="mb-2 text-sm font-semibold text-text-primary">
            Enroll via API
          </h2>
          <p className="mb-2 text-xs text-text-secondary">
            Use this endpoint to programmatically enroll a person into this
            sequence. Provide either{" "}
            <code className="text-accent">personId</code> (existing person) or{" "}
            <code className="text-accent">personEmail</code> (looks up or
            creates the person automatically):
          </p>
          <pre className="overflow-x-auto rounded-lg border border-border bg-white ring-1 ring-gray-200 p-4 text-xs text-text-secondary">
            {(() => {
              const usedSlugs = steps.map((s) => s.templateSlug).filter(Boolean);
              const usedTemplates = templates.filter((t) =>
                usedSlugs.includes(t.slug),
              );
              const varSet = new Set<string>();
              const varRegex = /\{\{(\w+)\}\}/g;
              for (const t of usedTemplates) {
                for (const src of [t.subject, t.bodyHtml]) {
                  let m: RegExpExecArray | null;
                  while ((m = varRegex.exec(src)) !== null) {
                    varSet.add(m[1]);
                  }
                }
              }
              const varsObj =
                varSet.size > 0
                  ? Object.fromEntries(
                      Array.from(varSet).map((v) => [v, `<${v.toUpperCase()}>`]),
                    )
                  : undefined;
              const body = JSON.stringify(
                {
                  personEmail: "<RECIPIENT_EMAIL>",
                  fromAddress: "<YOUR_SENDING_ADDRESS>",
                  ...(varsObj ? { variables: varsObj } : {}),
                },
                null,
                2,
              );
              return `curl -X POST ${window.location.origin}/api/sequences/${id}/enroll \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`;
            })()}
          </pre>
          {(() => {
            const usedSlugs = steps.map((s) => s.templateSlug).filter(Boolean);
            const usedTemplates = templates.filter((t) =>
              usedSlugs.includes(t.slug),
            );
            const templateVars: { slug: string; name: string; vars: string[] }[] = [];
            const varRegex = /\{\{(\w+)\}\}/g;
            for (const t of usedTemplates) {
              const vars = new Set<string>();
              for (const src of [t.subject, t.bodyHtml]) {
                let m: RegExpExecArray | null;
                while ((m = varRegex.exec(src)) !== null) {
                  vars.add(m[1]);
                }
              }
              if (vars.size > 0) {
                templateVars.push({ slug: t.slug, name: t.name, vars: Array.from(vars) });
              }
            }
            if (templateVars.length === 0) return null;
            return (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-text-secondary">
                  Template variables
                </p>
                <ul className="space-y-1 text-xs text-text-tertiary">
                  {templateVars.map((tv) => (
                    <li key={tv.slug}>
                      <span className="text-text-secondary">{tv.name}</span>
                      {" — "}
                      {tv.vars.map((v) => (
                        <code key={v} className="mr-1 text-accent">
                          {`{{${v}}}`}
                        </code>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
