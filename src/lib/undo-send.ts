import { showToast } from "@/lib/toast";
import { serverErrorMessage } from "@/lib/error-message";

/**
 * Gmail-style Undo Send: hold a send in the browser for a few seconds with
 * an Undo button, then really send it. The delay is the account setting
 * `layoutSettings.common.undoSendSeconds` (0 turns it off).
 *
 * While a send is held, closing the tab would lose it, so a beforeunload
 * prompt is armed until it goes out. Callers keep their draft autosaved, so
 * an undone send reopens with its content.
 */
export const UNDO_SEND_CHOICES = [0, 5, 10, 20, 30] as const;
export const DEFAULT_UNDO_SEND_SECONDS = 5;

let pending = 0;
function onBeforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = "";
}

export function sendWithUndo(opts: {
  /** Seconds to hold the send; 0 sends at once. */
  seconds: number;
  /** Performs the real send. */
  send: () => Promise<void>;
  /** Called when the user presses Undo (reopen the composer). */
  onUndo: () => void;
  /** Called after the real send succeeds. */
  onSent?: () => void;
  /** Called if the real send fails (the composer should reopen). */
  onError?: (err: unknown) => void;
  label?: string;
}): void {
  const { seconds, send, onUndo, onSent, onError } = opts;
  const run = async () => {
    try {
      await send();
      onSent?.();
      showToast({ kind: "success", message: "Message sent" });
    } catch (err) {
      showToast({
        kind: "error",
        message: "Message not sent",
        description: serverErrorMessage(err) ?? undefined,
      });
      onError?.(err);
    }
  };
  if (!seconds || seconds <= 0) {
    void run();
    return;
  }
  let cancelled = false;
  pending++;
  if (pending === 1) window.addEventListener("beforeunload", onBeforeUnload);
  const release = () => {
    pending = Math.max(0, pending - 1);
    if (pending === 0)
      window.removeEventListener("beforeunload", onBeforeUnload);
  };
  const timer = window.setTimeout(() => {
    release();
    if (!cancelled) void run();
  }, seconds * 1000);
  showToast({
    kind: "info",
    message: opts.label ?? "Sending…",
    durationMs: seconds * 1000,
    action: {
      label: "Undo",
      onClick: (dismiss) => {
        cancelled = true;
        window.clearTimeout(timer);
        release();
        dismiss();
        onUndo();
      },
    },
  });
}
