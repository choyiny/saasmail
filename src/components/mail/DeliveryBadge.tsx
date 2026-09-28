import { Clock, X } from "lucide-react";

/**
 * A delayed send (scheduled by a JMAP client) is in Sent before it goes out:
 * mark it "Scheduled for …" until then, or "Canceled" if it never will. Its
 * timestamp is the release time. Renders nothing for any other status.
 */
export default function DeliveryBadge({
  status,
  sendAt,
  size = "sm",
}: {
  status: string | null | undefined;
  sendAt: number;
  size?: "sm" | "md";
}) {
  if (status !== "scheduled" && status !== "canceled") return null;
  const text = size === "md" ? "text-[10px]" : "text-[9px]";
  if (status === "canceled") {
    return (
      <span
        data-testid="message-canceled-badge"
        title="This scheduled message was canceled and will not be sent."
        className={`inline-flex shrink-0 items-center gap-1 rounded bg-bg-muted px-1.5 py-0.5 ${text} font-medium uppercase tracking-wide text-text-secondary`}
      >
        <X size={10} />
        Canceled
      </span>
    );
  }
  const when = new Date(sendAt * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <span
      data-testid="message-scheduled-badge"
      title="Not sent yet. Cancel it from the Outbox before this time."
      className={`inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 ${text} font-medium text-amber-600`}
    >
      <Clock size={10} />
      Scheduled for {when}
    </span>
  );
}
