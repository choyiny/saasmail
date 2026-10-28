import type { ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared layout primitives for the tray-style modals (ComposeModal,
 * ReplyComposer, EmailHtmlModal). Keeps positioning, animation, and
 * the maximize/restore affordance consistent across all three so the
 * family feels like one component.
 */

export type TrayWidth = "compose" | "viewer";

interface TrayClassOpts {
  fullscreen: boolean;
  width: TrayWidth;
}

/**
 * Computes the className for the Radix DialogContent. In compact mode
 * the tray sits in the bottom-right corner; in fullscreen it grows to
 * cover the viewport with a small margin on every side. `overflow-
 * hidden` keeps inner backgrounds from poking past the rounded
 * corners (the previous markup leaked at the top edges).
 */
export function trayContentClass({ fullscreen, width }: TrayClassOpts): string {
  const base =
    "tray-content fixed z-50 flex flex-col overflow-hidden border border-border-strong bg-card text-text-primary shadow-overlay focus:outline-none transition-[inset,width,height,border-radius] duration-200 ease-out";
  if (fullscreen) {
    // Full viewport with a comfortable margin so the inbox peeks
    // around the edges and Esc/click-outside is easy to discover.
    return cn(base, "inset-3 rounded-2xl sm:inset-8");
  }
  // Compact: anchored bottom-right, taller than before so the editor
  // gets more room. Width depends on the tray's content type.
  const compactSize =
    width === "viewer"
      ? "sm:h-[720px] sm:w-[720px]"
      : "sm:h-[700px] sm:w-[640px]";
  return cn(
    base,
    "bottom-0 right-0 h-[92dvh] w-full rounded-t-2xl sm:bottom-4 sm:right-6 sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl",
    compactSize,
  );
}

/**
 * One row of the tray's metadata block (From / To / Cc / Subject).
 * The label sits in a fixed-width column so all rows align; the
 * field renders flush to the right with no inner border, giving
 * the dense single-row Gmail-style look.
 */
export function TrayMetaRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 sm:px-5">
      <label
        htmlFor={htmlFor}
        className="font-label w-16 shrink-0 text-[10.5px] text-text-tertiary"
      >
        {label}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Square icon button used to toggle the tray between compact and
 * fullscreen. Sits next to the close button in the header so the two
 * affordances feel paired.
 */
export function TrayMaximizeButton({
  fullscreen,
  onToggle,
}: {
  fullscreen: boolean;
  onToggle: () => void;
}) {
  const Icon = fullscreen ? Minimize2 : Maximize2;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={fullscreen ? "Restore size" : "Maximize"}
      title={fullscreen ? "Restore size" : "Maximize"}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
    >
      <Icon size={14} />
    </button>
  );
}
