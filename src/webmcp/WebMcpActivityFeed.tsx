import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Check, AlertCircle, Bot, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  WEBMCP_ACTIVITY_EVENT,
  type WebMcpActivity,
  type WebMcpActivityPhase,
} from "./activity";

// Cap the visual footprint — older cards drop off the top, and a busy group
// summarises the overflow rather than growing without bound.
const MAX_CARDS = 5;
const MAX_BULLETS = 8;
// How long a settled item lingers before it fades out. At least five seconds
// so there's always time to read it; errors stay longer. A card can always be
// dismissed sooner with its ✕ button.
const DISMISS_MS: Record<Exclude<WebMcpActivityPhase, "running">, number> = {
  success: 5000,
  error: 8000,
};

type Item = WebMcpActivity & { updatedAt: number };

// A card's group: either its shared header, or a singleton keyed by its id.
function groupKeyOf(it: WebMcpActivity): string {
  return it.group ? `g:${it.group}` : `one:${it.id}`;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/**
 * Bottom-right live feed of WebMCP tool calls. Subscribes to the activity
 * event bus (see ./activity.ts) so the user can watch a connected agent work
 * instead of facing an idle screen. Mounted only while WebMCP tools are
 * registered.
 *
 * Calls that share a `group` (e.g. reading several contacts' mail at once)
 * collapse into a single card with a per-call bullet list, so a burst of tool
 * calls stays legible. Text wraps rather than truncating.
 *
 * Deliberately bottom-right (toasts sit bottom-left); renders above the compose
 * drawer via a higher z-index and is pointer-transparent so it never blocks the
 * controls beneath it.
 */
export function WebMcpActivityFeed() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    function onActivity(e: Event) {
      const a = (e as CustomEvent<WebMcpActivity>).detail;
      if (!a?.id) return;
      setItems((prev) => {
        const without = prev.filter((x) => x.id !== a.id);
        // Stamp every event so a new/updated item extends its whole group's
        // on-screen time (see the sweep below).
        return [...without, { ...a, updatedAt: nowMs() }];
      });
    }
    window.addEventListener(WEBMCP_ACTIVITY_EVENT, onActivity as EventListener);
    return () =>
      window.removeEventListener(
        WEBMCP_ACTIVITY_EVENT,
        onActivity as EventListener,
      );
  }, []);

  // Sweep whole groups once they go quiet. A group lingers while ANY of its
  // items is still running; once all are settled, it stays until its most
  // recent event is older than the linger window — so a new item extends the
  // group, and the whole card drops at once rather than bullet-by-bullet.
  useEffect(() => {
    if (items.length === 0) return;
    const iv = setInterval(() => {
      setItems((prev) => {
        const t = nowMs();
        const byKey = new Map<string, Item[]>();
        for (const it of prev) {
          const key = groupKeyOf(it);
          const list = byKey.get(key);
          if (list) list.push(it);
          else byKey.set(key, [it]);
        }
        const drop = new Set<string>();
        for (const group of byKey.values()) {
          if (group.some((i) => i.phase === "running")) continue;
          const lastEvent = Math.max(...group.map((i) => i.updatedAt));
          const window = group.some((i) => i.phase === "error")
            ? DISMISS_MS.error
            : DISMISS_MS.success;
          if (t - lastEvent > window) {
            for (const i of group) drop.add(i.id);
          }
        }
        return drop.size === 0 ? prev : prev.filter((x) => !drop.has(x.id));
      });
    }, 500);
    return () => clearInterval(iv);
  }, [items.length]);

  const dismiss = useCallback((ids: string[]) => {
    const drop = new Set(ids);
    setItems((prev) => prev.filter((x) => !drop.has(x.id)));
  }, []);

  if (items.length === 0) return null;

  // Group by `group` header, keeping first-seen order. Ungrouped calls get a
  // singleton keyed by their id so they render as standalone cards.
  const order: string[] = [];
  const groups = new Map<string, Item[]>();
  for (const it of items) {
    const key = groupKeyOf(it);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(it);
  }
  const visibleKeys = order.slice(-MAX_CARDS);
  const anyRunning = items.some((i) => i.phase === "running");

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col items-stretch gap-2 sm:bottom-6 sm:right-6"
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
      {visibleKeys.map((key) => {
        const groupItems = groups.get(key)!;
        const ids = groupItems.map((g) => g.id);
        return key.startsWith("g:") ? (
          <GroupCard
            key={key}
            title={groupItems[0].group!}
            items={groupItems}
            onDismiss={() => dismiss(ids)}
          />
        ) : (
          <SingleCard
            key={key}
            activity={groupItems[0]}
            onDismiss={() => dismiss(ids)}
          />
        );
      })}
    </div>,
    document.body,
  );
}

function cardPhase(items: Item[]): WebMcpActivityPhase {
  if (items.some((i) => i.phase === "running")) return "running";
  if (items.some((i) => i.phase === "error")) return "error";
  return "success";
}

const cardShell =
  "webmcp-activity-enter pointer-events-auto rounded-[10px] border border-border bg-card px-3.5 py-3 shadow-lg ring-1 ring-black/5";

function SingleCard({
  activity,
  onDismiss,
}: {
  activity: Item;
  onDismiss: () => void;
}) {
  const { phase, label, tool, detail, durationMs } = activity;
  return (
    <div className={cn(cardShell, "flex items-start gap-2.5")}>
      <PhaseIcon phase={phase} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 break-words text-sm font-medium text-text-primary">
            {label}
          </p>
          {phase !== "running" && typeof durationMs === "number" && (
            <span className="mt-0.5 shrink-0 text-[10px] tabular-nums text-text-tertiary">
              {formatDuration(durationMs)}
            </span>
          )}
        </div>
        <p className="mt-0.5 break-all font-mono text-[11px] text-text-tertiary">
          {tool}
        </p>
        {phase === "error" && detail && (
          <p className="mt-1 break-words text-[11px] text-destructive">
            {detail}
          </p>
        )}
      </div>
      <DismissButton onDismiss={onDismiss} />
    </div>
  );
}

function GroupCard({
  title,
  items,
  onDismiss,
}: {
  title: string;
  items: Item[];
  onDismiss: () => void;
}) {
  const phase = cardPhase(items);
  const shown = items.slice(-MAX_BULLETS);
  const overflow = items.length - shown.length;
  return (
    <div className={cn(cardShell, "flex flex-col")}>
      <div className="flex items-start gap-2.5">
        <PhaseIcon phase={phase} />
        <p className="min-w-0 flex-1 break-words text-sm font-medium text-text-primary">
          {title}
          <span className="ml-1 font-normal text-text-tertiary">
            · {items.length}
          </span>
        </p>
        <DismissButton onDismiss={onDismiss} />
      </div>
      <ul className="mt-2 space-y-1 pl-1">
        {shown.map((it) => (
          <li key={it.id} className="flex items-start gap-2">
            <BulletIcon phase={it.phase} />
            <span className="min-w-0 flex-1 break-words text-[12px] text-text-secondary">
              {it.subject ?? it.label}
            </span>
          </li>
        ))}
        {overflow > 0 && (
          <li className="pl-[18px] text-[11px] text-text-tertiary">
            +{overflow} more
          </li>
        )}
      </ul>
    </div>
  );
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss"
      className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-text-tertiary/70 transition-colors hover:bg-bg-muted hover:text-text-primary"
    >
      <X size={13} />
    </button>
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

function BulletIcon({ phase }: { phase: WebMcpActivityPhase }) {
  if (phase === "running") {
    return (
      <Loader2 size={11} className="mt-0.5 shrink-0 animate-spin text-violet" />
    );
  }
  if (phase === "success") {
    return (
      <Check
        size={11}
        className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
      />
    );
  }
  return <AlertCircle size={11} className="mt-0.5 shrink-0 text-destructive" />;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}
