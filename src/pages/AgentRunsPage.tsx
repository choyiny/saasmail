import { useState, useEffect } from "react";
import { fetchAgentRuns, type AgentRun } from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  succeeded: "bg-green-50 text-green-700",
  failed: "bg-red-50 text-red-700",
  running: "bg-blue-50 text-blue-700",
  queued: "bg-yellow-50 text-yellow-700",
};

function statusColor(status: string) {
  if (status.startsWith("skipped_")) return "bg-gray-100 text-gray-500";
  return STATUS_COLORS[status] ?? "bg-gray-100 text-gray-500";
}

export default function AgentRunsPage() {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchAgentRuns({ status: status || undefined, limit, offset })
      .then((data) => {
        setRuns(data.runs);
        setTotal(data.total);
      })
      .finally(() => setLoading(false));
  }, [status, limit, offset]);

  function formatTs(ts: number) {
    return new Date(ts * 1000).toLocaleString();
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-sm font-semibold text-text-primary">
            Agent Runs
          </h1>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
            className="rounded-md border border-border px-2 py-1 text-xs focus:outline-none"
          >
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="skipped_inactive">Skipped (inactive)</option>
            <option value="skipped_mode">Skipped (mode)</option>
            <option value="skipped_loop">Skipped (loop)</option>
            <option value="skipped_rate_limit">Skipped (rate limit)</option>
          </select>
        </div>

        {loading ? (
          <p className="text-xs text-text-tertiary">Loading...</p>
        ) : runs.length === 0 ? (
          <p className="text-xs text-text-tertiary">No runs yet.</p>
        ) : (
          <>
            <div className="space-y-1">
              {runs.map((r) => (
                <div key={r.id}>
                  <div
                    className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-white px-4 py-3 ring-1 ring-gray-200 hover:bg-bg-subtle"
                    onClick={() =>
                      setExpandedId(expandedId === r.id ? null : r.id)
                    }
                  >
                    <div>
                      <p className="text-[11px] font-medium text-text-primary">
                        {formatTs(r.createdAt)}
                      </p>
                      <p className="text-[10px] text-text-tertiary">
                        Person: {r.personId.slice(0, 12)}…
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {r.action && (
                        <span className="text-[10px] text-text-tertiary">
                          {r.action}
                        </span>
                      )}
                      {(r.inputTokens || r.outputTokens) && (
                        <span className="text-[10px] text-text-tertiary">
                          {r.inputTokens ?? 0}↑ {r.outputTokens ?? 0}↓
                        </span>
                      )}
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor(r.status)}`}
                      >
                        {r.status}
                      </span>
                    </div>
                  </div>
                  {expandedId === r.id && (
                    <div className="rounded-b-lg border border-t-0 border-border bg-bg-subtle px-4 py-3 text-[11px] text-text-secondary space-y-1">
                      <p>
                        <span className="text-text-tertiary">Run ID:</span>{" "}
                        {r.id}
                      </p>
                      <p>
                        <span className="text-text-tertiary">Email ID:</span>{" "}
                        {r.emailId}
                      </p>
                      <p>
                        <span className="text-text-tertiary">Assignment:</span>{" "}
                        {r.assignmentId}
                      </p>
                      {r.modelId && (
                        <p>
                          <span className="text-text-tertiary">Model:</span>{" "}
                          {r.modelId}
                        </p>
                      )}
                      {r.errorMessage && (
                        <p className="text-red-600">
                          <span className="text-text-tertiary">Error:</span>{" "}
                          {r.errorMessage}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between text-[11px] text-text-tertiary">
              <span>
                Showing {offset + 1}–{Math.min(offset + limit, total)} of{" "}
                {total}
              </span>
              <div className="flex gap-2">
                <button
                  disabled={offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - limit))}
                  className="rounded-md border border-border px-2.5 py-1 disabled:opacity-40 hover:bg-bg-muted"
                >
                  ← Prev
                </button>
                <button
                  disabled={offset + limit >= total}
                  onClick={() => setOffset((o) => o + limit)}
                  className="rounded-md border border-border px-2.5 py-1 disabled:opacity-40 hover:bg-bg-muted"
                >
                  Next →
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
