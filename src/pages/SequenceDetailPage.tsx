import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  fetchSequence,
  fetchSequenceEnrollments,
  cancelEnrollment,
  type Sequence,
  type EnrollmentWithDetails,
} from "@/lib/api";

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    active: "bg-green-900/50 text-green-400",
    completed: "bg-blue-900/50 text-blue-400",
    cancelled: "bg-red-900/50 text-red-400",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-gray-800 text-gray-400"}`}
    >
      {status}
    </span>
  );
}

export default function SequenceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [enrollments, setEnrollments] = useState<EnrollmentWithDetails[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([fetchSequence(id), fetchSequenceEnrollments(id)])
      .then(([seq, enrs]) => {
        setSequence(seq);
        setEnrollments(enrs);
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function handleCancel(enrollmentId: string) {
    if (!confirm("Cancel this enrollment?")) return;
    await cancelEnrollment(enrollmentId);
    setEnrollments((prev) =>
      prev.map((e) =>
        e.id === enrollmentId ? { ...e, status: "cancelled" } : e,
      ),
    );
  }

  if (loading || !sequence) {
    return (
      <div className="flex-1 p-6">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-6">
        <button
          onClick={() => navigate("/sequences")}
          className="mb-2 text-xs text-text-tertiary hover:text-text-secondary"
        >
          &larr; Back to Sequences
        </button>
        <h1 className="text-xl font-semibold text-text-primary">
          {sequence.name}
        </h1>
        <p className="text-sm text-text-secondary">
          {sequence.steps.length} step{sequence.steps.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Steps preview */}
      <div className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-text-secondary">Steps</h2>
        <div className="space-y-1">
          {sequence.steps.map((step, idx) => (
            <div
              key={step.order}
              className="flex items-center gap-3 rounded border border-border-dark bg-card px-3 py-2 text-sm"
            >
              <span className="text-text-tertiary">#{idx + 1}</span>
              <span className="text-text-primary">{step.templateSlug}</span>
              <span className="text-text-tertiary">
                {step.delayHours === 0
                  ? "immediately"
                  : `after ${step.delayHours}h`}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Enrollments */}
      <div>
        <h2 className="mb-3 text-sm font-medium text-text-secondary">
          Enrollments ({enrollments.length})
        </h2>
        {enrollments.length === 0 ? (
          <p className="text-sm text-text-tertiary">No enrollments yet.</p>
        ) : (
          <div className="space-y-2">
            {enrollments.map((enr) => (
              <div
                key={enr.id}
                className="flex items-center justify-between rounded-lg border border-border-dark bg-card px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {enr.senderName ?? enr.senderEmail}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {enr.senderEmail} &middot; {enr.sentSteps}/{enr.totalSteps}{" "}
                    sent
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {statusBadge(enr.status)}
                  {enr.status === "active" && (
                    <button
                      onClick={() => handleCancel(enr.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
