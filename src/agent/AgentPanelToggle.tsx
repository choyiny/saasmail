import { createContext, useContext, type ReactNode } from "react";
import { Bot } from "lucide-react";

/**
 * Whether the mail agent panel is open, shared by DashboardLayout (which
 * owns the state and the Ctrl/⌘+J shortcut) and the toggle button each
 * layout's header renders.
 */
export const AgentPanelContext = createContext<{
  open: boolean;
  toggle: () => void;
}>({ open: false, toggle: () => {} });

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(
    `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`,
  );
}

/** The agent toggle for a layout's global actions, styled by the layout. */
export function AgentToggleButton({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const { open, toggle } = useContext(AgentPanelContext);
  const label = `Toggle mail agent (${isMacPlatform() ? "⌘J" : "Ctrl+J"})`;
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      aria-pressed={open}
      onClick={toggle}
    >
      {children ?? <Bot size={17} />}
    </button>
  );
}
