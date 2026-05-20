import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, ListOrdered, Pencil, Trash2, Clock } from "lucide-react";
import { fetchSequences, deleteSequence, type Sequence } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";

/** Round delay-hours into a friendlier string for the row chip. */
function formatTotalDelay(hours: number): string {
  if (hours <= 0) return "instant";
  if (hours < 24) return `${hours}h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return days === 1 ? "1 day" : `${days} days`;
}

function totalDurationHours(seq: Sequence): number {
  return seq.steps.reduce((acc, s) => acc + (s.delayHours || 0), 0);
}

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchSequences()
      .then(setSequences)
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(id: string) {
    if (!confirm("Delete this sequence?")) return;
    try {
      await deleteSequence(id);
      setSequences((prev) => prev.filter((s) => s.id !== id));
    } catch {
      alert("Cannot delete — sequence may have active enrollments.");
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Sequences"
        subtitle="Multi-step drip campaigns. Enroll a contact and saasmail sends templated emails on a schedule."
        action={
          <button
            onClick={() => navigate("/sequences/new")}
            className="inline-flex items-center gap-1.5 rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90"
          >
            <Plus size={14} />
            New sequence
          </button>
        }
      />

      <div className="max-w-4xl">
        {loading ? (
          <p className="text-sm font-light text-text-tertiary">Loading…</p>
        ) : sequences.length === 0 ? (
          <div className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet/10">
              <ListOrdered size={20} style={{ color: "#7c5cfc" }} />
            </span>
            <p className="mb-1 text-sm font-medium text-text-primary">
              No sequences yet
            </p>
            <p className="text-xs font-light text-text-tertiary">
              Build your first multi-step campaign to nurture contacts
              automatically.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <ul className="divide-y divide-border/60">
              {sequences.map((seq) => {
                const total = totalDurationHours(seq);
                return (
                  <li
                    key={seq.id}
                    data-testid="sequence-row"
                    data-sequence-id={seq.id}
                    className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-text-primary/[0.02]"
                  >
                    <Link
                      to={`/sequences/${seq.id}`}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                        <ListOrdered size={14} className="text-text-tertiary" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {seq.name}
                          </p>
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet/10 px-2 py-0.5 text-[10px] font-medium tabular-nums"
                            style={{ color: "#7c5cfc" }}
                            title={`${seq.steps.length} step${seq.steps.length === 1 ? "" : "s"}`}
                          >
                            {seq.steps.length} step
                            {seq.steps.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-light text-text-tertiary">
                          <Clock size={10} />
                          spans {formatTotalDelay(total)}
                        </p>
                      </div>
                    </Link>
                    <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => navigate(`/sequences/${seq.id}/edit`)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                      >
                        <Pencil size={12} />
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(seq.id)}
                        aria-label="Delete"
                        className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
