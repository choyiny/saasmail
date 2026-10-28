import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  ListOrdered,
  Pencil,
  Users,
  XCircle,
} from "lucide-react";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { avatarColor } from "@/lib/avatar";
import { SectionHeader } from "@/components/PageForm";
import {
  fetchSequence,
  fetchSequenceEnrollments,
  cancelEnrollment,
  type Sequence,
  type EnrollmentWithDetails,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/** Round delay-hours into a friendlier string for the step timeline. */
function formatDelay(hours: number): string {
  if (hours <= 0) return "immediately";
  if (hours < 24) return `${hours}h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return days === 1 ? "1 day" : `${days} days`;
}

function totalDelayLabel(steps: { delayHours: number }[]): string {
  const total = steps.reduce((acc, s) => acc + (s.delayHours || 0), 0);
  return formatDelay(total);
}

function relativeTime(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const days = Math.floor(diff / 86400);
  if (days < 30) return `${days}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

type Status = "active" | "completed" | "cancelled";

const STATUS_META: Record<
  Status,
  {
    label: string;
    /** pt-chip tone */
    tone: string;
    /** Token colour for the progress bar / icon. */
    color: string;
    Icon: React.ElementType;
  }
> = {
  active: {
    label: "Active",
    tone: "info",
    color: "var(--sm-run)",
    Icon: Clock,
  },
  completed: {
    label: "Completed",
    tone: "ok",
    color: "var(--sm-ok)",
    Icon: CheckCircle2,
  },
  cancelled: {
    label: "Cancelled",
    tone: "",
    color: "var(--sm-faint)",
    Icon: XCircle,
  },
};

function StatusBadge({ status }: { status: string }) {
  const key: Status =
    status === "active" || status === "completed" || status === "cancelled"
      ? status
      : "cancelled";
  const meta = STATUS_META[key];
  return (
    <span className={cn("pt-chip", meta.tone)}>
      <meta.Icon />
      {meta.label}
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
    if (!confirm("Cancel this enrollment? Pending steps won't be sent.")) {
      return;
    }
    await cancelEnrollment(enrollmentId);
    setEnrollments((prev) =>
      prev.map((e) =>
        e.id === enrollmentId ? { ...e, status: "cancelled" } : e,
      ),
    );
  }

  // Bucket enrollments by status so each section shows just the relevant
  // rows. Active first because that's where most operator attention goes.
  const grouped = useMemo(() => {
    const buckets: Record<string, EnrollmentWithDetails[]> = {
      active: [],
      completed: [],
      cancelled: [],
    };
    for (const e of enrollments) {
      const k = (buckets[e.status] ? e.status : "cancelled") as string;
      buckets[k].push(e);
    }
    return buckets;
  }, [enrollments]);

  if (loading || !sequence) {
    return (
      <PageContainer>
        <div className="flex flex-col gap-4" aria-busy="true">
          <span className="pt-skel h-6 w-56" />
          <span className="pt-skel h-48 w-full rounded-2xl" />
          <span className="pt-skel h-40 w-full rounded-2xl" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Link
        to="/sequences"
        className="-mt-1 mb-2 inline-flex items-center gap-1 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={14} />
        Sequences
      </Link>

      <PageHeader
        title={sequence.name}
        subtitle={
          <>
            {sequence.steps.length} step
            {sequence.steps.length === 1 ? "" : "s"} · spans{" "}
            {totalDelayLabel(sequence.steps)} · {enrollments.length} enrollment
            {enrollments.length === 1 ? "" : "s"}
          </>
        }
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate(`/sequences/${sequence.id}/edit`)}
          >
            <Pencil />
            Edit sequence
          </Button>
        }
      />

      <div className="space-y-5">
        {/* --- Steps timeline --- */}
        <section className="pt-card overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={ListOrdered}
              title="Steps"
              subtitle="The journey every enrollment follows. Delays are measured from the previous step."
            />
          </div>
          <ol className="relative space-y-0">
            {sequence.steps.map((step, idx) => {
              const isLast = idx === sequence.steps.length - 1;
              return (
                <li
                  key={step.order}
                  className="relative flex items-start gap-3 px-5 py-4"
                >
                  {/* Connector line — visually links steps. */}
                  {!isLast && (
                    <span
                      aria-hidden
                      className="absolute left-[34px] top-12 h-[calc(100%-2.5rem)] w-px bg-border-strong"
                    />
                  )}
                  <span className="tabular relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent-subtle bg-accent-subtle text-xs font-semibold text-accent-subtle-fg">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-text-primary">
                      <code className="font-code text-[13px]">
                        {step.templateSlug}
                      </code>
                    </p>
                    <p className="mt-0.5 text-[13px] text-text-secondary">
                      {idx === 0
                        ? "Sends right when someone is enrolled."
                        : `Sends ${formatDelay(step.delayHours)} after step ${idx}.`}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        {/* --- Enrollments --- */}
        <section className="pt-card overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Users}
              title={`Enrollments (${enrollments.length})`}
              subtitle="Every contact who has been enrolled into this sequence."
            />
          </div>

          {enrollments.length === 0 ? (
            <div className="pt-empty">
              <span className="ic">
                <Users size={18} />
              </span>
              <p>
                No enrollments yet. Open a conversation and choose “Add to
                sequence”, or enroll contacts through the API.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {(["active", "completed", "cancelled"] as Status[]).map(
                (statusKey) => {
                  const rows = grouped[statusKey] ?? [];
                  if (rows.length === 0) return null;
                  return (
                    <EnrollmentGroup
                      key={statusKey}
                      status={statusKey}
                      rows={rows}
                      onCancel={handleCancel}
                    />
                  );
                },
              )}
            </div>
          )}
        </section>
      </div>
    </PageContainer>
  );
}

function EnrollmentGroup({
  status,
  rows,
  onCancel,
}: {
  status: Status;
  rows: EnrollmentWithDetails[];
  onCancel: (id: string) => void;
}) {
  const meta = STATUS_META[status];
  return (
    <div>
      <div className="flex h-9 items-center gap-2 border-b border-border bg-bg-subtle px-5">
        <span className="pt-sdot" style={{ background: meta.color }} />
        <h3 className="font-label text-text-secondary">
          {meta.label} · {rows.length}
        </h3>
      </div>
      <ul className="divide-y divide-border-subtle">
        {rows.map((enr) => {
          const progress =
            enr.totalSteps > 0 ? enr.sentSteps / enr.totalSteps : 0;
          const initial = (enr.personName ?? enr.personEmail)
            .trim()
            .charAt(0)
            .toUpperCase();
          return (
            <li
              key={enr.id}
              data-testid="enrollment-row"
              data-enrollment-id={enr.id}
              className="flex items-center gap-3 px-5 py-3"
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                style={{
                  backgroundColor: avatarColor(enr.personEmail).bg,
                  color: avatarColor(enr.personEmail).fg,
                }}
              >
                {initial || "?"}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[14px] font-medium text-text-primary">
                    {enr.personName ?? enr.personEmail}
                  </p>
                  <StatusBadge status={enr.status} />
                </div>
                <p className="truncate text-[13px] text-text-secondary">
                  {enr.personEmail} · enrolled {relativeTime(enr.enrolledAt)}
                </p>
              </div>

              <div className="hidden shrink-0 items-center gap-3 sm:flex">
                <div className="w-32">
                  <div className="tabular flex items-center justify-between text-xs">
                    <span className="text-text-tertiary">
                      {enr.sentSteps}/{enr.totalSteps}
                    </span>
                    <span className="text-text-tertiary">
                      {Math.round(progress * 100)}%
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-muted">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.max(progress * 100, 2)}%`,
                        backgroundColor: STATUS_META[status].color,
                      }}
                    />
                  </div>
                </div>
              </div>

              {enr.status === "active" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onCancel(enr.id)}
                  aria-label="Cancel"
                  className="shrink-0 hover:text-destructive"
                >
                  Cancel
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
