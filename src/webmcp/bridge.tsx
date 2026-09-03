import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface ComposeSeed {
  from?: string;
  to?: string;
  subject?: string;
  bodyHtml?: string;
  cc?: { email: string; name?: string | null }[];
}

export interface WebMcpBridge {
  navigate: (path: string) => void;
  openCompose: (seed: ComposeSeed) => void;
}

const BridgeContext = createContext<WebMcpBridge | null>(null);

export function useWebMcpBridge(): WebMcpBridge {
  const ctx = useContext(BridgeContext);
  if (!ctx)
    throw new Error("useWebMcpBridge must be used within WebMcpBridgeProvider");
  return ctx;
}

/**
 * Provides the WebMcpBridge — the thin set of UI actions the tools drive
 * through (router navigation and the compose drawer). Tools that mutate data
 * (enroll, reply drafts) call the API directly and then refresh the view via
 * lib/inbox-events, so the bridge renders no modal of its own.
 */
export function WebMcpBridgeProvider({
  navigate,
  openCompose,
  children,
}: {
  navigate: (path: string) => void;
  openCompose: (seed: ComposeSeed) => void;
  children: ReactNode;
}) {
  const bridge = useMemo<WebMcpBridge>(
    () => ({ navigate, openCompose }),
    [navigate, openCompose],
  );

  return (
    <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>
  );
}
