/**
 * Tiny global toast system. Anywhere in the app can call `showToast`;
 * the singleton <Toaster/> mounted in DashboardLayout subscribes to
 * the same custom event and renders the queue.
 *
 * Custom events keep the wiring zero-dependency — no React context,
 * no prop-drilling.
 */

export const TOAST_EVENT = "saasmail:toast";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastInit {
  kind?: ToastKind;
  /** Main line — kept short. */
  message: string;
  /** Optional secondary line under the message. */
  description?: string;
  /** Optional CTA button — receives the dismiss fn so it can close itself. */
  action?: {
    label: string;
    onClick: (dismiss: () => void) => void;
  };
  /** ms before auto-dismiss. Default 4500. Set to 0 to require manual close. */
  durationMs?: number;
}

export function showToast(t: ToastInit): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: t }));
}
