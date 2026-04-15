import { useState, useEffect } from "react";
import {
  fetchSenderEnrollment,
  cancelEnrollment,
  type SenderEnrollmentInfo,
} from "@/lib/api";

interface SequenceStatusProps {
  senderId: string;
  onStatusChange: () => void;
}

export default function SequenceStatus({
  senderId,
  onStatusChange,
}: SequenceStatusProps) {
  const [info, setInfo] = useState<SenderEnrollmentInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchSenderEnrollment(senderId)
      .then(setInfo)
      .finally(() => setLoading(false));
  }, [senderId]);

  if (loading || !info || !info.enrollment) return null;

  const sent = info.scheduledEmails.filter((e) => e.status === "sent").length;
  const total = info.scheduledEmails.length;
  const nextPending = info.scheduledEmails.find(
    (e) => e.status === "pending" || e.status === "queued"
  );

  async function handleCancel() {
    if (!info?.enrollment) return;
    if (!confirm("Cancel this sequence?")) return;
    await cancelEnrollment(info.enrollment.id);
    onStatusChange();
    setInfo({ ...info, enrollment: null, scheduledEmails: [], sequenceName: null });
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-green-800/50 bg-green-900/20 px-3 py-2 text-sm">
      <div className="flex-1">
        <p className="font-medium text-green-400">
          Sequence: {info.sequenceName}
        </p>
        <p className="text-xs text-text-secondary">
          {sent}/{total} sent
          {nextPending &&
            ` · Next: ${new Date(nextPending.scheduledAt * 1000).toLocaleString()}`}
        </p>
      </div>
      <button
        onClick={handleCancel}
        className="text-xs text-red-400 hover:text-red-300"
      >
        Cancel
      </button>
    </div>
  );
}
