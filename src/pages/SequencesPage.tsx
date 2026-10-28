import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, ListOrdered, Pencil, Trash2, Clock } from "lucide-react";
import { fetchSequences, deleteSequence, type Sequence } from "@/lib/api";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";

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
        subtitle="Multi-step drip campaigns. Enroll a contact and templated emails go out on a schedule."
        action={
          <Button onClick={() => navigate("/sequences/new")}>
            <Plus />
            New sequence
          </Button>
        }
      />

      <div>
        {loading ? (
          <div
            className="pt-card divide-y divide-border-subtle"
            aria-busy="true"
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-4">
                <span className="pt-skel h-9 w-9 rounded-lg" />
                <span className="flex flex-1 flex-col gap-2">
                  <span className="pt-skel h-3 w-1/3" />
                  <span className="pt-skel h-2.5 w-1/4" />
                </span>
              </div>
            ))}
          </div>
        ) : sequences.length === 0 ? (
          <div className="pt-card pt-empty">
            <span className="ic">
              <ListOrdered size={18} />
            </span>
            <p>
              No sequences yet. Build one to follow up with contacts
              automatically.
            </p>
            <Button
              variant="outline"
              onClick={() => navigate("/sequences/new")}
            >
              <Plus />
              Create a sequence
            </Button>
          </div>
        ) : (
          <div className="pt-card overflow-hidden">
            <div className="hidden h-9 items-center gap-4 border-b border-border bg-bg-subtle px-5 sm:flex">
              <span className="font-label flex-1 text-text-secondary">
                Sequence
              </span>
              <span className="font-label w-24 text-right text-text-secondary">
                Steps
              </span>
              <span className="w-[104px]" />
            </div>
            <ul className="divide-y divide-border-subtle">
              {sequences.map((seq) => {
                const total = totalDurationHours(seq);
                return (
                  <li
                    key={seq.id}
                    data-testid="sequence-row"
                    data-sequence-id={seq.id}
                    className="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-bg-subtle sm:gap-4 sm:px-5"
                  >
                    <Link
                      to={`/sequences/${seq.id}`}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-subtle">
                        <ListOrdered
                          size={15}
                          className="text-text-secondary"
                        />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-medium text-text-primary">
                          {seq.name}
                        </p>
                        <p className="mt-0.5 inline-flex items-center gap-1 text-[13px] text-text-secondary">
                          <Clock size={12} className="text-text-tertiary" />
                          Spans {formatTotalDelay(total)}
                        </p>
                      </div>
                    </Link>
                    <span className="hidden w-24 justify-end sm:flex">
                      <span
                        className="pt-chip tabular"
                        title={`${seq.steps.length} step${seq.steps.length === 1 ? "" : "s"}`}
                      >
                        {seq.steps.length} step
                        {seq.steps.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    <div className="flex shrink-0 items-center justify-end sm:w-[104px] gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/sequences/${seq.id}/edit`)}
                      >
                        <Pencil />
                        <span className="max-sm:sr-only">Edit</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(seq.id)}
                        aria-label="Delete"
                        className="h-8 w-8 hover:bg-destructive-subtle hover:text-destructive"
                      >
                        <Trash2 />
                      </Button>
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
