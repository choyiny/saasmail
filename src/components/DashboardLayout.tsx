import { useCallback, useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import TopNav from "@/components/TopNav";
import Breadcrumbs from "@/components/Breadcrumbs";
import Footer from "@/components/Footer";
import ComposeFab from "@/components/ComposeFab";
import ComposeModal, { type ComposePrefill } from "@/pages/ComposeModal";
import Toaster from "@/components/Toaster";
import { useReducedAnimations } from "@/hooks/useReducedAnimations";
import { useBranding } from "@/lib/branding";
import { WebMcpBridgeProvider } from "@/webmcp/bridge";
import { WebMcpTools } from "@/webmcp/registerTools";
import AgentPanel from "@/components/AgentPanel";
import { AgentContextProvider } from "@/agent/AgentContext";

const AGENT_PANEL_STORAGE_KEY = "saasmail.agentPanelOpen";

function initialAgentPanelOpen(): boolean {
  try {
    return window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

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
  const reduced = useReducedAnimations();

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

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposePrefill(null);
    setComposeContextKey("compose");
  }, []);

  return (
    <WebMcpBridgeProvider navigate={navigate} openCompose={openCompose}>
      <AgentContextProvider>
        {webmcpEnabled && <WebMcpTools />}
        <div className="relative flex min-h-screen flex-col bg-background pt-16">
          {/* Faded gradient backdrop. Animates by default; falls back to a
            static version on low-spec devices or when the user prefers
            reduced motion. */}
          <div
            className={
              reduced
                ? "dashboard-backdrop dashboard-backdrop-static"
                : "dashboard-backdrop"
            }
            aria-hidden
          />
          <div className="dashboard-backdrop-mask" aria-hidden />

          <TopNav
            agentOpen={agentOpen}
            onAgentToggle={() => setAgentOpen((open) => !open)}
          />

          <div className="relative z-10 flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <Breadcrumbs />
              <main className="flex min-h-0 flex-1 flex-col">
                <Outlet context={{ onCompose: openCompose }} />
              </main>
              <Footer />
            </div>
            {agentOpen && (
              <AgentPanel
                onClose={() => setAgentOpen(false)}
                onOpenCompose={openCompose}
              />
            )}
          </div>

          <ComposeFab onClick={() => openCompose()} />

          <ComposeModal
            open={composeOpen}
            onClose={closeCompose}
            prefill={composePrefill}
            contextKey={composeContextKey}
          />

          <Toaster />
        </div>
      </AgentContextProvider>
    </WebMcpBridgeProvider>
  );
}
