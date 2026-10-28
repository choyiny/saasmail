import type { ReactNode } from "react";
import type { ComposePrefill } from "@/pages/ComposeModal";

/**
 * Contract every mail theme implements. DashboardLayout renders the active
 * theme's Shell around every signed-in page, and the inbox routes render its
 * Inbox. Settings, templates, sequences and admin pages render unchanged
 * inside the Shell's content area and pick up the theme's colours, fonts
 * and radii from the CSS tokens (see src/index.css).
 */
export interface ThemeShellProps {
  children: ReactNode;
  onCompose: (prefill?: ComposePrefill) => void;
}

export interface MailThemeModule {
  Shell: (props: ThemeShellProps) => ReactNode;
  Inbox: () => ReactNode;
}
