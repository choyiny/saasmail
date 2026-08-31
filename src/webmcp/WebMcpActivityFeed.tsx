import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Check, AlertCircle, Bot, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  WEBMCP_ACTIVITY_EVENT,
  type WebMcpActivity,
  type WebMcpActivityPhase,
} from "./activity";

// At most this many cards at once — older ones drop off the top of the stack.
const MAX_VISIBLE = 4;
// How long a settled card lingers before it fades out, once it finishes. At
// least five seconds so there's always time to read it; errors stay longer.
// (A card can always be dismissed sooner with its ✕ button.)
const DISMISS_MS: Record<Exclude<WebMcpActivityPhase, "running">, number> = {
  success: 5000,
  error: 8000,
};

/**
 * Bottom-right live feed of WebMCP tool calls. Subscribes to the activity
 * event bus (see ./activity.ts) and shows one card per in-flight or
 * recently-finished tool, so the user can watch a connected agent work instead
 * of facing an idle screen. Mounted only while WebMCP tools are registered.
 *
 * Deliberately bottom-right (the toasts sit bottom-left); it renders above the
 * compose drawer via a higher z-index and is pointer-transparent so it never
 * blocks the controls beneath it.
 */
export function WebMcpActivityFeed() {
  const [items, setItems] = useState<WebMcpActivity[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timersMap = timers.current;
    function onActivity(e: Event) {
      const a = (e as CustomEvent<WebMcpActivity>).detail;
      if (!a?.id) return;

      // Update in place if this invocation is already on screen, else append.
      setItems((prev) => {
        const without = prev.filter((x) => x.id !== a.id);
        return [...without, a].slice(-MAX_VISIBLE);
      });

      // Reset any pending dismissal — a running→done update restarts the clock.
      const pending = timersMap.get(a.id);
      if (pending) {
        clearTimeout(pending);
        timersMap.delete(a.id);
      }
      if (a.phase !== "running") {
        const tid = setTimeout(() => {
          setItems((prev) => prev.filter((x) => x.id !== a.id));
          timersMap.delete(a.id);
        }, DISMISS_MS[a.phase]);
        timersMap.set(a.id, tid);
      }
    }

    window.addEventListener(WEBMCP_ACTIVITY_EVENT, onActivity as EventListener);
    return () => {
      window.removeEventListener(
        WEBMCP_ACTIVITY_EVENT,
        onActivity as EventListener,
      );
      timersMap.forEach((t) => clearTimeout(t));
      timersMap.clear();
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  if (items.length === 0) return null;

  const anyRunning = items.some((i) => i.phase === "running");

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[320px] max-w-[calc(100vw-2rem)] flex-col items-stretch gap-2 sm:bottom-6 sm:right-6"
      role="status"
      aria-live="polite"
      aria-label="WebMCP agent activity"
    >
      <div className="flex items-center gap-1.5 self-end rounded-full border border-border bg-card/90 px-2.5 py-1 text-[11px] font-medium text-text-tertiary shadow-sm backdrop-blur">
        <Bot size={12} className="text-violet" />
        <span>Agent activity</span>
        {anyRunning && (
          <span className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-violet" />
        )}
      </div>
      {items.map((a) => (
        <ActivityCard key={a.id} activity={a} onDismiss={() => dismiss(a.id)} />
      ))}
    </div>,
    document.body,
  );
}

function ActivityCard({
  activity,
  onDismiss,
}: {
  activity: WebMcpActivity;
  onDismiss: () => void;
}) {
  const { phase, label, tool, detail, durationMs } = activity;
  return (
    <div
      className={cn(
        "webmcp-activity-enter pointer-events-auto flex items-start gap-2.5 rounded-[10px] border border-border bg-card px-3.5 py-3 shadow-lg ring-1 ring-black/5",
      )}
    >
      <PhaseIcon phase={phase} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-medium text-text-primary">
            {label}
          </p>
          {phase !== "running" && typeof durationMs === "number" && (
            <span className="shrink-0 text-[10px] tabular-nums text-text-tertiary">
              {formatDuration(durationMs)}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-text-tertiary">
          {tool}
        </p>
        {phase === "error" && detail && (
          <p className="mt-1 line-clamp-2 text-[11px] text-destructive">
            {detail}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-text-tertiary/70 transition-colors hover:bg-bg-muted hover:text-text-primary"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function PhaseIcon({ phase }: { phase: WebMcpActivityPhase }) {
  if (phase === "running") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet/10 ring-1 ring-violet/30">
        <Loader2 size={12} className="animate-spin text-violet" />
      </span>
    );
  }
  if (phase === "success") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/30">
        <Check size={12} className="text-emerald-600 dark:text-emerald-400" />
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/30">
      <AlertCircle size={12} className="text-destructive" />
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}
