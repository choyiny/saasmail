import { PauseCircle } from "lucide-react";
import { useBranding } from "@/lib/branding";
import { cn } from "@/lib/utils";

/** The composers' line while an administrator has paused outbound sending. */
export default function SendingPausedNotice({
  className,
}: {
  className?: string;
}) {
  const { outboundPaused } = useBranding();
  if (!outboundPaused) return null;
  return (
    <p
      role="status"
      data-testid="sending-paused-notice"
      className={cn(
        "flex items-center gap-1.5 text-[11px] font-medium text-warning-text",
        className,
      )}
    >
      <PauseCircle size={12} aria-hidden />
      Sending is paused; your message will be queued.
    </p>
  );
}
