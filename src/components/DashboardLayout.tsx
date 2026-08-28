import { useCallback, useState } from "react";
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

export default function DashboardLayout() {
  const navigate = useNavigate();
  const { webmcpEnabled } = useBranding();
  const [composeOpen, setComposeOpen] = useState(false);
  // Optional seed values for the compose drawer — populated when the user
  // opts into the "full compose" flow from inside a chat thread.
  const [composePrefill, setComposePrefill] = useState<ComposePrefill | null>(
    null,
  );
  const reduced = useReducedAnimations();

  const openCompose = useCallback((prefill?: ComposePrefill) => {
    setComposePrefill(prefill ?? null);
    setComposeOpen(true);
  }, []);

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposePrefill(null);
  }, []);

  return (
    <WebMcpBridgeProvider
      navigate={(path) => navigate(path)}
      openCompose={openCompose}
    >
      {webmcpEnabled && <WebMcpTools enabled={true} />}
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

        <TopNav />
        <Breadcrumbs />

        <main className="relative z-10 flex min-h-0 flex-1 flex-col">
          <Outlet context={{ onCompose: openCompose }} />
        </main>

        <div className="relative z-10">
          <Footer />
        </div>

        <ComposeFab onClick={() => openCompose()} />

        <ComposeModal
          open={composeOpen}
          onClose={closeCompose}
          prefill={composePrefill}
        />

        <Toaster />
      </div>
    </WebMcpBridgeProvider>
  );
}
