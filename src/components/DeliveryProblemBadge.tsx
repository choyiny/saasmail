import { AlertTriangle } from "lucide-react";
import type { DeliveryProblem } from "@/lib/api";

const LABEL: Record<DeliveryProblem["kind"], string> = {
  bounced: "Bounced",
  complained: "Marked as spam",
  rejected: "Rejected",
  failed: "Not delivered",
};

/** When one message has several kinds, the chip names the most serious. */
const SEVERITY: DeliveryProblem["kind"][] = [
  "bounced",
  "complained",
  "rejected",
  "failed",
];

function describe(problem: DeliveryProblem): string {
  const what =
    problem.kind === "bounced" && problem.bounceType
      ? `${problem.bounceType} bounce`
      : LABEL[problem.kind].toLowerCase();
  return [`${problem.recipient}: ${what}`, problem.smtpStatus, problem.detail]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What the provider reported after it accepted a sent message: a bounce, a
 * spam complaint, a rejection or a failure (docs/suppressions.md). The
 * tooltip names each recipient with its SMTP status and detail. Renders
 * nothing without problems.
 */
export default function DeliveryProblemBadge({
  problems,
  recipientCount,
}: {
  problems: DeliveryProblem[] | null | undefined;
  /** Everyone the message was sent to, for "Bounced for 1 of 3". */
  recipientCount: number;
}) {
  if (!problems || problems.length === 0) return null;
  const kind = SEVERITY.find((k) => problems.some((p) => p.kind === k))!;
  const affected = new Set(problems.map((p) => p.recipient)).size;
  const label =
    recipientCount > 1
      ? `${LABEL[kind]} for ${Math.min(affected, recipientCount)} of ${recipientCount}`
      : LABEL[kind];
  const details = problems.map(describe).join("\n");
  return (
    <span
      data-testid="message-delivery-problem-badge"
      title={details}
      className="pt-chip bad shrink-0"
    >
      <AlertTriangle size={10} aria-hidden="true" />
      {label}
      <span className="sr-only">. {details}</span>
    </span>
  );
}
