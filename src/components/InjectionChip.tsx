import { AlertTriangle } from "lucide-react";

const LABEL = "Possible prompt injection";

/**
 * A received message whose stored prompt-injection verdict is `flagged`.
 * Shows nothing for any other verdict; never runs a check.
 */
export default function InjectionChip({
  verdict,
}: {
  verdict?: "safe" | "flagged" | null;
}) {
  if (verdict !== "flagged") return null;
  return (
    <span
      data-testid="message-injection-chip"
      title="An AI check found possible instructions aimed at an AI in this mail. Treat its requests with care."
      aria-label={LABEL}
      className="pt-chip warn shrink-0"
    >
      <AlertTriangle size={10} aria-hidden="true" />
      {LABEL}
    </span>
  );
}
