import { useEffect, useRef, useState } from "react";
import { Download, Upload, UserPlus, X } from "lucide-react";
import {
  addListMember,
  cancelImportJob,
  fetchImportJob,
  fetchListMembers,
  listMembersExportUrl,
  startListImport,
  unsubscribeListMember,
  type ImportJob,
  type ListMember,
  type MemberStatus,
} from "@/lib/api";

const STATUS_STYLE: Record<MemberStatus, string> = {
  subscribed: "bg-emerald-500/10 text-emerald-700",
  pending: "bg-amber-500/10 text-amber-700",
  unsubscribed: "bg-bg-muted text-text-tertiary",
};

const FILTERS: Array<{ label: string; value: MemberStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Subscribed", value: "subscribed" },
  { label: "Pending", value: "pending" },
  { label: "Unsubscribed", value: "unsubscribed" },
];

function formatDate(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleDateString() : "—";
}

export default function ListMembersTable({ listId }: { listId: string }) {
  const [members, setMembers] = useState<ListMember[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<MemberStatus | "all">("all");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function load(reset = true) {
    setLoading(true);
    try {
      const r = await fetchListMembers(listId, {
        status: filter === "all" ? undefined : filter,
        cursor: reset ? undefined : (cursor ?? undefined),
      });
      setMembers((prev) => (reset ? r.items : [...prev, ...r.items]));
      setCursor(r.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId, filter]);

  /**
   * Poll an import while it runs.
   *
   * The job is processed by a queue consumer, not by the request that started
   * it, so there is no response to await — the only way to show progress is to
   * ask.
   */
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = setInterval(async () => {
      try {
        const next = await fetchImportJob(listId, job.jobId);
        setJob(next);
        if (next.status !== "running") void load(true);
      } catch {
        // A transient failure should not kill the poll; the next tick retries.
      }
    }, 1500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId, job?.status, listId]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await addListMember(listId, { email: newEmail.trim() });
      setNewEmail("");
      setAdding(false);
      void load(true);
    } catch {
      setError("Could not add that address.");
    }
  }

  async function handleRemove(member: ListMember) {
    if (
      !confirm(
        `Unsubscribe ${member.email}? The membership row is kept — it is the consent record for this address.`,
      )
    ) {
      return;
    }
    await unsubscribeListMember(listId, member.id);
    void load(true);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const { jobId } = await startListImport(listId, file);
      setJob({
        jobId,
        status: "running",
        totalRows: null,
        processedRows: 0,
        importedCount: 0,
        skippedCount: 0,
        errors: [],
      });
    } catch {
      setError("Could not start the import. Is the file a CSV?");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-[6px] px-2.5 py-1.5 text-xs font-medium transition-colors ${
                filter === f.value
                  ? "bg-text-primary text-white"
                  : "text-text-secondary hover:bg-bg-muted"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setAdding((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted"
          >
            <UserPlus size={12} />
            Add
          </button>
          <button
            onClick={() => fileInput.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted"
          >
            <Upload size={12} />
            Import CSV
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFile}
            className="hidden"
          />
          <a
            href={listMembersExportUrl(listId)}
            className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted"
          >
            <Download size={12} />
            Export
          </a>
        </div>
      </div>

      {adding && (
        <form
          onSubmit={handleAdd}
          className="mb-3 flex items-center gap-2 rounded-[8px] bg-card p-3 ring-1 ring-border"
        >
          <input
            required
            type="email"
            autoFocus
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="subscriber@example.com"
            className="flex-1 rounded-[6px] border border-border bg-card px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-[6px] bg-text-primary px-3 py-2 text-xs font-medium text-white"
          >
            Add
          </button>
        </form>
      )}

      {job && (
        <div className="mb-3 rounded-[8px] bg-card p-3 text-xs ring-1 ring-border">
          <div className="flex items-center justify-between">
            <span className="font-medium text-text-primary">
              Import {job.status}
              {job.totalRows !== null &&
                ` — ${job.processedRows} of ${job.totalRows} rows`}
            </span>
            {job.status === "running" ? (
              <button
                onClick={async () => {
                  await cancelImportJob(listId, job.jobId);
                  setJob({ ...job, status: "cancelled" });
                }}
                className="text-text-tertiary hover:text-text-primary"
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={() => setJob(null)}
                className="text-text-tertiary hover:text-text-primary"
                aria-label="Dismiss"
              >
                <X size={12} />
              </button>
            )}
          </div>
          {job.status !== "running" && (
            <p className="mt-1 text-text-tertiary">
              {job.importedCount} imported, {job.skippedCount} skipped
              {job.errors.length > 0 && ` — ${job.errors.length} errors`}
            </p>
          )}
        </div>
      )}

      {error && <p className="mb-3 text-xs text-red-600">{error}</p>}

      {loading && members.length === 0 ? (
        <p className="text-sm font-light text-text-tertiary">Loading…</p>
      ) : members.length === 0 ? (
        <div className="rounded-[8px] bg-card p-8 text-center ring-1 ring-border">
          <p className="text-sm text-text-tertiary">No members here yet.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <table className="w-full text-sm">
            <thead className="bg-bg-muted/50 text-left text-[11px] uppercase tracking-wide text-text-tertiary">
              <tr>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Consent</th>
                <th className="px-4 py-2 font-medium">Since</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {members.map((m) => (
                <tr key={m.id} data-testid="member-row">
                  <td className="px-4 py-2.5">
                    <span className="text-text-primary">{m.email}</span>
                    {m.name && (
                      <span className="ml-2 text-xs text-text-tertiary">
                        {m.name}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[m.status]}`}
                    >
                      {m.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-text-tertiary">
                    {m.consentSource}
                    {m.consentAt ? ` · ${formatDate(m.consentAt)}` : ""}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-text-tertiary">
                    {formatDate(m.subscribedAt ?? m.createdAt)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {m.status !== "unsubscribed" && (
                      <button
                        onClick={() => handleRemove(m)}
                        className="text-xs text-text-tertiary hover:text-text-primary"
                      >
                        Unsubscribe
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor && (
        <button
          onClick={() => void load(false)}
          disabled={loading}
          className="mt-3 rounded-[6px] px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-muted disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
