import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, AlertTriangle, Info, X, XCircle } from "lucide-react";
import { TOAST_EVENT, type ToastInit, type ToastKind } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface ToastItem extends ToastInit {
  id: string;
}

const KIND_META: Record<ToastKind, { Icon: React.ElementType; tone: string }> =
  {
    info: { Icon: Info, tone: "text-text-secondary" },
    success: { Icon: CheckCircle2, tone: "text-success" },
    warning: { Icon: AlertTriangle, tone: "text-warning" },
    error: { Icon: XCircle, tone: "text-destructive" },
  };

/**
 * Mount once near the root (DashboardLayout). Listens for
 * `saasmail:toast` custom events and renders a small stack of
 * dismissible cards anchored to the bottom-left so they don't
 * collide with the bottom-right tray modals.
 */
export default function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  // Track timer ids so manual dismiss can clear pending auto-dismiss.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<ToastInit>).detail;
      if (!detail || typeof detail.message !== "string") return;
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `t_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      setItems((prev) => [...prev, { id, ...detail }]);
      const ms = detail.durationMs ?? 4500;
      if (ms > 0) {
        const handle = setTimeout(() => dismiss(id), ms);
        timersRef.current.set(id, handle);
      }
    }
    window.addEventListener(TOAST_EVENT, handler);
    return () => {
      window.removeEventListener(TOAST_EVENT, handler);
      // Clean up any outstanding timers if the Toaster unmounts.
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, [dismiss]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-live="polite"
      className="sm-toaster pointer-events-none fixed bottom-4 left-3 right-3 z-[60] flex max-w-[380px] flex-col gap-2 sm:bottom-6 sm:left-6 sm:right-auto sm:w-full"
      style={{
        bottom: "max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))",
      }}
    >
      {items.map((it) => {
        const meta = KIND_META[it.kind ?? "info"];
        return (
          <div
            key={it.id}
            role="status"
            className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border-strong bg-popover py-2.5 pl-3.5 pr-2 text-text-primary shadow-overlay"
          >
            <meta.Icon
              size={16}
              className={cn("shrink-0 self-start mt-0.5", meta.tone)}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium leading-snug text-text-primary">
                {it.message}
              </p>
              {it.description && (
                <p className="mt-0.5 text-[12.5px] text-text-secondary">
                  {it.description}
                </p>
              )}
            </div>
            {it.action && (
              <button
                type="button"
                onClick={() => it.action?.onClick(() => dismiss(it.id))}
                className="shrink-0 rounded-md px-2 py-1 text-[13px] font-semibold text-accent-subtle-fg transition-colors hover:bg-accent-subtle"
              >
                {it.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(it.id)}
              aria-label="Dismiss"
              className="shrink-0 rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
