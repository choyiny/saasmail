import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Outlet, useNavigate } from "react-router-dom";
import PortalShell from "@/components/shell/PortalShell";
import SendingPausedBanner from "@/components/SendingPausedBanner";
import ComposeFab from "@/components/ComposeFab";
import ComposeModal, { type ComposePrefill } from "@/pages/ComposeModal";
import Toaster from "@/components/Toaster";
import { useBranding } from "@/lib/branding";
import { WebMcpBridgeProvider } from "@/webmcp/bridge";
import { WebMcpTools } from "@/webmcp/registerTools";
import AgentPanel from "@/components/AgentPanel";
import { AgentContextProvider } from "@/agent/AgentContext";
import { AgentPanelContext } from "@/agent/AgentPanelToggle";
import { useUiTheme } from "@/lib/preferences";

const AGENT_PANEL_STORAGE_KEY = "saasmail.agentPanelOpen";

function initialAgentPanelOpen(): boolean {
  try {
    return window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const GmailShell = lazy(() => import("@/themes/gmail/GmailShell"));
const OutlookShell = lazy(() => import("@/themes/outlook/OutlookShell"));

export default function DashboardLayout() {
  const navigate = useNavigate();
  const { webmcpEnabled } = useBranding();
  const [composeOpen, setComposeOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(initialAgentPanelOpen);
  const [composeContextKey, setComposeContextKey] = useState("compose");
  // Optional seed values for the compose drawer — populated when the user
  // opts into the "full compose" flow from inside a chat thread.
  const [composePrefill, setComposePrefill] = useState<ComposePrefill | null>(
    null,
  );
  const ui = useUiTheme();

  const openCompose = useCallback(
    (prefill?: ComposePrefill, contextKey = "compose") => {
      setComposePrefill(prefill ?? null);
      setComposeContextKey(contextKey);
      setComposeOpen(true);
    },
    [],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(AGENT_PANEL_STORAGE_KEY, String(agentOpen));
    } catch {
      // Storage can be unavailable in private browsing or embedded contexts.
    }
  }, [agentOpen]);

  useEffect(() => {
    function handleAgentShortcut(event: KeyboardEvent) {
      if (event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      setAgentOpen((open) => !open);
    }
    window.addEventListener("keydown", handleAgentShortcut);
    return () => window.removeEventListener("keydown", handleAgentShortcut);
  }, []);

  const toggleAgent = useCallback(() => setAgentOpen((open) => !open), []);
  const agentToggle = useMemo(
    () => ({ open: agentOpen, toggle: toggleAgent }),
    [agentOpen, toggleAgent],
  );

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposePrefill(null);
    setComposeContextKey("compose");
  }, []);

  return (
    <WebMcpBridgeProvider navigate={navigate} openCompose={openCompose}>
      <AgentContextProvider>
        <AgentPanelContext.Provider value={agentToggle}>
          {webmcpEnabled && <WebMcpTools />}
          {/* The agent panel and the sending-paused banner sit outside the
            layout switch, so every layout keeps them. */}
          <div className="flex h-dvh flex-col overflow-hidden">
            <SendingPausedBanner />
            <div className="flex min-h-0 flex-1">
              <div className="dash-shell min-w-0 flex-1">
                {ui === "default" ? (
                  <PortalShell onCompose={() => openCompose()}>
                    <Outlet context={{ onCompose: openCompose }} />
                  </PortalShell>
                ) : (
                  <Suspense fallback={null}>
                    {(() => {
                      const Shell = ui === "gmail" ? GmailShell : OutlookShell;
                      return (
                        <Shell onCompose={openCompose}>
                          <Outlet context={{ onCompose: openCompose }} />
                        </Shell>
                      );
                    })()}
                  </Suspense>
                )}
              </div>
              {agentOpen && (
                <AgentPanel
                  onClose={() => setAgentOpen(false)}
                  onOpenCompose={openCompose}
                />
              )}
            </div>
          </div>

          {ui === "default" && <ComposeFab onClick={() => openCompose()} />}

          <ComposeModal
            open={composeOpen}
            onClose={closeCompose}
            prefill={composePrefill}
            contextKey={composeContextKey}
            onReopen={openCompose}
          />
          <Toaster />
        </AgentPanelContext.Provider>
      </AgentContextProvider>
    </WebMcpBridgeProvider>
  );
}
