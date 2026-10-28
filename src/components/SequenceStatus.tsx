import { useState, useEffect } from "react";
import {
  fetchPersonEnrollment,
  cancelEnrollment,
  type PersonEnrollmentInfo,
} from "@/lib/api";

interface SequenceStatusProps {
  personId: string;
  onStatusChange: () => void;
}

export default function SequenceStatus({
  personId,
  onStatusChange,
}: SequenceStatusProps) {
  const [info, setInfo] = useState<PersonEnrollmentInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchPersonEnrollment(personId)
      .then(setInfo)
      .finally(() => setLoading(false));
  }, [personId]);

  if (loading || !info || !info.enrollment) return null;

  // 'suppressed' is a completed-but-not-delivered terminal state — count it
  // toward the progress display so completed-via-suppression enrollments
  // don't look stuck.
  const sent = info.scheduledEmails.filter(
    (e) => e.status === "sent" || e.status === "suppressed",
  ).length;
  const total = info.scheduledEmails.length;
  const nextPending = info.scheduledEmails.find(
    (e) => e.status === "pending" || e.status === "queued",
  );

  async function handleCancel() {
    if (!info?.enrollment) return;
    if (!confirm("Cancel this sequence?")) return;
    await cancelEnrollment(info.enrollment.id);
    onStatusChange();
    setInfo({
      ...info,
      enrollment: null,
      scheduledEmails: [],
      sequenceName: null,
    });
  }

  return (
    <div className="inline-flex h-8 min-w-0 items-center gap-2 rounded-lg border border-info/25 bg-info-subtle pl-2.5 pr-1 text-[13px]">
      <span className="pt-sdot info" aria-hidden />
      <span className="min-w-0 truncate">
        <span className="font-medium text-text-primary">
          {info.sequenceName}
        </span>
        <span className="tabular text-text-secondary">
          {" "}
          · {sent}/{total} sent
          {nextPending &&
            ` · next ${new Date(nextPending.scheduledAt * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}
        </span>
      </span>
      <button
        onClick={handleCancel}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-text-secondary transition-colors hover:bg-destructive-subtle hover:text-destructive"
      >
        Cancel
      </button>
    </div>
  );
}
