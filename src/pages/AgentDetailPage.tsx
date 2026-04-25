import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  fetchAgentDefinition,
  fetchAgentAssignments,
  fetchTemplates,
  createAgentAssignment,
  updateAgentAssignment,
  deleteAgentAssignment,
  type AgentDefinition,
  type AgentAssignment,
  type EmailTemplate,
} from "@/lib/api";

const MODE_LABELS: Record<string, string> = {
  first_thread_reply: "First reply",
  every_mail_reply: "Every reply",
  draft_only: "Draft only",
};

interface AssignmentForm {
  mailbox: string;
  personId: string;
  templateSlug: string;
  mode: AgentAssignment["mode"];
  isActive: boolean;
}

const DEFAULT_FORM: AssignmentForm = {
  mailbox: "",
  personId: "",
  templateSlug: "",
  mode: "every_mail_reply",
  isActive: true,
};

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [agent, setAgent] = useState<AgentDefinition | null>(null);
  const [assignments, setAssignments] = useState<AgentAssignment[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AssignmentForm>(DEFAULT_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      fetchAgentDefinition(id),
      fetchAgentAssignments(id),
      fetchTemplates(),
    ])
      .then(([agentData, assignmentData, templateData]) => {
        setAgent(agentData);
        setAssignments(assignmentData);
        setTemplates(templateData);
      })
      .finally(() => setLoading(false));
  }, [id]);

  function openCreate() {
    setEditingId(null);
    setForm(DEFAULT_FORM);
    setFormError(null);
    setShowDialog(true);
  }

  function openEdit(a: AgentAssignment) {
    setEditingId(a.id);
    setForm({
      mailbox: a.mailbox ?? "",
      personId: a.personId ?? "",
      templateSlug: a.templateSlug,
      mode: a.mode,
      isActive: a.isActive,
    });
    setFormError(null);
    setShowDialog(true);
  }

  async function handleSave() {
    if (!form.templateSlug) {
      setFormError("Template is required");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        agentId: id!,
        mailbox: form.mailbox || null,
        personId: form.personId || null,
        templateSlug: form.templateSlug,
        mode: form.mode,
        isActive: form.isActive,
      };
      if (editingId) {
        const updated = await updateAgentAssignment(editingId, payload);
        setAssignments((prev) =>
          prev.map((a) => (a.id === editingId ? updated : a)),
        );
      } else {
        const created = await createAgentAssignment(payload);
        setAssignments((prev) => [...prev, created]);
      }
      setShowDialog(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("409"))
        setFormError("An active assignment already exists for this scope.");
      else if (msg.includes("422"))
        setFormError("Template variables don't match agent output fields.");
      else setFormError("Failed to save assignment.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAssignment(aId: string) {
    if (!confirm("Delete this assignment?")) return;
    await deleteAgentAssignment(aId);
    setAssignments((prev) => prev.filter((a) => a.id !== aId));
  }

  if (loading)
    return <div className="p-6 text-xs text-text-tertiary">Loading...</div>;
  if (!agent)
    return (
      <div className="p-6 text-xs text-text-tertiary">Agent not found.</div>
    );

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Agent definition card */}
        <div className="rounded-lg border border-border bg-white px-5 py-4 ring-1 ring-gray-200">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <h1 className="text-sm font-semibold text-text-primary">
                {agent.name}
              </h1>
              {agent.description && (
                <p className="mt-0.5 text-[11px] text-text-tertiary">
                  {agent.description}
                </p>
              )}
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => navigate(`/agents/${agent.id}/edit`)}
                className="rounded-md px-2.5 py-1 text-[11px] text-text-secondary hover:bg-bg-muted"
              >
                Edit
              </button>
              <button
                onClick={() => navigate("/agents")}
                className="rounded-md px-2.5 py-1 text-[11px] text-text-tertiary hover:bg-bg-muted"
              >
                ← Back
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[11px]">
            <div>
              <span className="text-text-tertiary">Model: </span>
              <span className="font-mono text-text-primary">
                {agent.modelId}
              </span>
            </div>
            <div>
              <span className="text-text-tertiary">Max runs/hr: </span>
              <span className="text-text-primary">{agent.maxRunsPerHour}</span>
            </div>
            <div>
              <span className="text-text-tertiary">Status: </span>
              <span
                className={agent.isActive ? "text-green-600" : "text-gray-400"}
              >
                {agent.isActive ? "Active" : "Inactive"}
              </span>
            </div>
          </div>
          <div className="mt-3">
            <p className="mb-1 text-[11px] text-text-tertiary">
              Output fields:
            </p>
            <div className="flex flex-wrap gap-1">
              {agent.outputFields.map((f) => (
                <span
                  key={f.name}
                  title={f.description}
                  className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent"
                >
                  {`{{${f.name}}}`}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-3">
            <p className="mb-1 text-[11px] text-text-tertiary">
              System prompt:
            </p>
            <pre className="rounded-md bg-bg-subtle px-3 py-2 text-[11px] text-text-primary whitespace-pre-wrap">
              {agent.systemPrompt}
            </pre>
          </div>
        </div>

        {/* Assignments section */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-text-primary">
              Assignments
            </h2>
            <button
              onClick={openCreate}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
            >
              New Assignment
            </button>
          </div>

          {assignments.length === 0 ? (
            <p className="text-xs text-text-tertiary">No assignments yet.</p>
          ) : (
            <div className="space-y-1">
              {assignments.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-white px-4 py-3 ring-1 ring-gray-200"
                >
                  <div>
                    <p className="text-xs font-medium text-text-primary">
                      {a.mailbox ?? "*"} / {a.personId ?? "*"}
                    </p>
                    <p className="text-[11px] text-text-tertiary">
                      {a.templateName} &middot; {MODE_LABELS[a.mode] ?? a.mode}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        a.isActive
                          ? "bg-green-50 text-green-700"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {a.isActive ? "Active" : "Inactive"}
                    </span>
                    <button
                      onClick={() => openEdit(a)}
                      className="rounded-md px-2.5 py-1 text-[11px] text-text-secondary hover:bg-bg-muted"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeleteAssignment(a.id)}
                      className="rounded-md px-2.5 py-1 text-[11px] text-destructive hover:bg-bg-muted"
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

      {/* Assignment dialog */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-sm font-semibold text-text-primary">
              {editingId ? "Edit Assignment" : "New Assignment"}
            </h3>
            {formError && (
              <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
                {formError}
              </p>
            )}
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-text-primary">
                  Mailbox{" "}
                  <span className="font-normal text-text-tertiary">
                    (leave blank for any)
                  </span>
                </label>
                <input
                  value={form.mailbox}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, mailbox: e.target.value }))
                  }
                  className="w-full rounded-md border border-border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
                  placeholder="inbox@example.com"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-text-primary">
                  Person ID{" "}
                  <span className="font-normal text-text-tertiary">
                    (leave blank for any)
                  </span>
                </label>
                <input
                  value={form.personId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, personId: e.target.value }))
                  }
                  className="w-full rounded-md border border-border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
                  placeholder="person ID"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-text-primary">
                  Template
                </label>
                <select
                  value={form.templateSlug}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, templateSlug: e.target.value }))
                  }
                  className="w-full rounded-md border border-border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
                >
                  <option value="">Select a template…</option>
                  {templates.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.name} ({t.slug})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-text-primary">
                  Mode
                </label>
                <select
                  value={form.mode}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      mode: e.target.value as AgentAssignment["mode"],
                    }))
                  }
                  className="w-full rounded-md border border-border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
                >
                  <option value="first_thread_reply">First reply</option>
                  <option value="every_mail_reply">Every reply</option>
                  <option value="draft_only">Draft only</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="asgn-active"
                  checked={form.isActive}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, isActive: e.target.checked }))
                  }
                  className="h-4 w-4 accent-accent"
                />
                <label
                  htmlFor="asgn-active"
                  className="text-xs font-medium text-text-primary"
                >
                  Active
                </label>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowDialog(false)}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
