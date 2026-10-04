import { useEffect, useState } from "react";
import { PauseCircle } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";
import {
  fetchAdminSettings,
  updateAdminSettings,
  type AdminSettings,
} from "@/lib/api";

/** "14:02" today, "Oct 3, 14:02" another day. */
export function formatPausedSince(since: number, now = new Date()): string {
  const at = new Date(since * 1000);
  const sameDay = at.toDateString() === now.toDateString();
  return at.toLocaleString(
    undefined,
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  );
}

/**
 * Shown to admins on every page while outbound sending is paused, with who
 * paused it, since when, and a way to resume.
 */
export default function SendingPausedBanner() {
  const { data: session } = useSession();
  const { outboundPaused, refresh } = useBranding();
  const isAdmin = session?.user?.role === "admin";
  const [pause, setPause] = useState<AdminSettings["outboundPause"]>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin || !outboundPaused) return;
    let cancelled = false;
    fetchAdminSettings()
      .then((settings) => {
        if (!cancelled) setPause(settings.outboundPause);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAdmin, outboundPaused]);

  if (!isAdmin || !outboundPaused) return null;

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      await updateAdminSettings({ outboundPaused: false });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resume sending.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      data-testid="sending-paused-banner"
      className="mx-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[8px] border border-warning-border bg-warning-bg px-4 py-2.5 text-xs text-warning-text sm:mx-6"
    >
      <PauseCircle size={14} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">
        Outbound sending is paused
        {pause && pause.since > 0
          ? ` since ${formatPausedSince(pause.since)}`
          : ""}
        {pause?.byLabel ? ` by ${pause.byLabel}` : ""}. New messages are queued
        and go out when you resume.
      </span>
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={resume}
        disabled={busy}
        className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Resuming…" : "Resume"}
      </button>
    </div>
  );
}
