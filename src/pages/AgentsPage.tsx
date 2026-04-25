import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  fetchAgentDefinitions,
  deleteAgentDefinition,
  type AgentDefinition,
} from "@/lib/api";

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchAgentDefinitions()
      .then(setAgents)
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(id: string) {
    if (!confirm("Delete this agent?")) return;
    try {
      await deleteAgentDefinition(id);
      setAgents((prev) => prev.filter((a) => a.id !== id));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("409") || msg.includes("assignment")) {
        alert("Deactivate or delete all assignments for this agent first.");
      } else {
        alert("Failed to delete agent.");
      }
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-sm font-semibold text-text-primary">Agents</h1>
          <button
            onClick={() => navigate("/agents/new")}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
          >
            New Agent
          </button>
        </div>

        {loading ? (
          <p className="text-xs text-text-tertiary">Loading...</p>
        ) : agents.length === 0 ? (
          <p className="text-xs text-text-tertiary">
            No agents yet. Create one to automate email replies.
          </p>
        ) : (
          <div className="space-y-1">
            {agents.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between rounded-lg border border-border bg-white px-4 py-3 ring-1 ring-gray-200"
              >
                <div>
                  <p className="text-xs font-medium text-text-primary">
                    {a.name}
                  </p>
                  <p className="text-[11px] text-text-tertiary">
                    {a.modelId} &middot; {a.outputFields.length} field
                    {a.outputFields.length !== 1 ? "s" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
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
                    onClick={() => navigate(`/agents/${a.id}/edit`)}
                    className="rounded-md px-2.5 py-1 text-[11px] text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => navigate(`/agents/${a.id}`)}
                    className="rounded-md px-2.5 py-1 text-[11px] text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                  >
                    Assignments
                  </button>
                  <button
                    onClick={() => handleDelete(a.id)}
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
  );
}
