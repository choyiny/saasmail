import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { fetchSequences, deleteSequence, type Sequence } from "@/lib/api";

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
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Sequences</h1>
        <button
          onClick={() => navigate("/sequences/new")}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
        >
          New Sequence
        </button>
      </div>

      {loading ? (
        <p className="text-text-secondary">Loading...</p>
      ) : sequences.length === 0 ? (
        <p className="text-text-secondary">No sequences yet.</p>
      ) : (
        <div className="space-y-2">
          {sequences.map((seq) => (
            <div
              key={seq.id}
              className="flex items-center justify-between rounded-lg border border-border bg-white ring-1 ring-gray-200 px-4 py-3"
            >
              <div
                className="cursor-pointer"
                onClick={() => navigate(`/sequences/${seq.id}`)}
              >
                <p className="font-medium text-text-primary">{seq.name}</p>
                <p className="text-xs text-text-secondary">
                  {seq.steps.length} step{seq.steps.length !== 1 ? "s" : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => navigate(`/sequences/${seq.id}/edit`)}
                  className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(seq.id)}
                  className="rounded-md border border-border px-2 py-1 text-xs text-red-400 hover:bg-bg-muted"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
