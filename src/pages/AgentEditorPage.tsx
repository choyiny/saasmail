import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  fetchAgentDefinition,
  createAgentDefinition,
  updateAgentDefinition,
  type OutputField,
} from "@/lib/api";

export default function AgentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [modelId, setModelId] = useState("@cf/meta/llama-3.3-70b-instruct");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [outputFields, setOutputFields] = useState<OutputField[]>([
    { name: "", description: "" },
  ]);
  const [maxRunsPerHour, setMaxRunsPerHour] = useState(10);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);

  useEffect(() => {
    if (!id) return;
    fetchAgentDefinition(id)
      .then((a) => {
        setName(a.name);
        setDescription(a.description ?? "");
        setModelId(a.modelId);
        setSystemPrompt(a.systemPrompt);
        setOutputFields(
          a.outputFields.length > 0
            ? a.outputFields
            : [{ name: "", description: "" }],
        );
        setMaxRunsPerHour(a.maxRunsPerHour);
        setIsActive(a.isActive);
      })
      .finally(() => setLoading(false));
  }, [id]);

  function updateField(index: number, key: keyof OutputField, value: string) {
    setOutputFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, [key]: value } : f)),
    );
  }

  function addField() {
    setOutputFields((prev) => [...prev, { name: "", description: "" }]);
  }

  function removeField(index: number) {
    setOutputFields((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!systemPrompt.trim()) {
      setError("System prompt is required");
      return;
    }
    if (outputFields.length === 0) {
      setError("At least one output field is required");
      return;
    }
    const invalidField = outputFields.find(
      (f) => !f.name.trim() || !/^\w+$/.test(f.name),
    );
    if (invalidField) {
      setError("Field names must be alphanumeric/underscore with no spaces");
      return;
    }

    setSaving(true);
    try {
      if (isEdit && id) {
        await updateAgentDefinition(id, {
          name,
          description: description || undefined,
          modelId,
          systemPrompt,
          outputFields,
          maxRunsPerHour,
          isActive,
        });
      } else {
        await createAgentDefinition({
          name,
          description: description || undefined,
          modelId,
          systemPrompt,
          outputFields,
          maxRunsPerHour,
          isActive,
        });
      }
      navigate("/agents");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        msg.includes("422")
          ? "Template mismatch — check that your output fields cover all template variables in existing assignments."
          : "Failed to save agent.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading)
    return <div className="p-6 text-xs text-text-tertiary">Loading...</div>;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-6 text-sm font-semibold text-text-primary">
          {isEdit ? "Edit Agent" : "New Agent"}
        </h1>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
              {error}
            </p>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-text-primary">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
              placeholder="e.g. Welcome Reply Agent"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-primary">
              Description{" "}
              <span className="font-normal text-text-tertiary">(optional)</span>
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-md border border-border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-primary">
              Model ID
            </label>
            <input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="w-full rounded-md border border-border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
              placeholder="@cf/meta/llama-3.3-70b-instruct"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-primary">
              System Prompt
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
              placeholder="You are a helpful assistant that replies to customer emails..."
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium text-text-primary">
                Output Fields
              </label>
              <button
                type="button"
                onClick={addField}
                className="text-[11px] text-accent hover:underline"
              >
                + Add Field
              </button>
            </div>
            <div className="space-y-2">
              {outputFields.map((field, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={field.name}
                    onChange={(e) => updateField(i, "name", e.target.value)}
                    className="w-32 rounded-md border border-border px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent/30"
                    placeholder="fieldName"
                  />
                  <input
                    value={field.description}
                    onChange={(e) =>
                      updateField(i, "description", e.target.value)
                    }
                    className="flex-1 rounded-md border border-border px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
                    placeholder="What this field contains"
                  />
                  {outputFields.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeField(i)}
                      className="text-[11px] text-destructive hover:text-red-700"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-text-tertiary">
              Field names become template variables:{" "}
              <code>{"{{fieldName}}"}</code>
            </p>
          </div>

          <div className="flex gap-6">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-primary">
                Max Runs / Hour
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={maxRunsPerHour}
                onChange={(e) => setMaxRunsPerHour(Number(e.target.value))}
                className="w-24 rounded-md border border-border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
            <div className="flex items-end gap-2">
              <input
                type="checkbox"
                id="isActive"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              <label
                htmlFor="isActive"
                className="text-xs font-medium text-text-primary"
              >
                Active
              </label>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => navigate("/agents")}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
