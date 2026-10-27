import { useCallback, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import PortalShell from "@/components/shell/PortalShell";
import ComposeFab from "@/components/ComposeFab";
import ComposeModal, { type ComposePrefill } from "@/pages/ComposeModal";
import Toaster from "@/components/Toaster";
import { useBranding } from "@/lib/branding";
import { WebMcpBridgeProvider } from "@/webmcp/bridge";
import { WebMcpTools } from "@/webmcp/registerTools";
import { lazy, Suspense } from "react";
import { useUiTheme } from "@/lib/preferences";

const GmailShell = lazy(() => import("@/themes/gmail/GmailShell"));
const OutlookShell = lazy(() => import("@/themes/outlook/OutlookShell"));

export default function DashboardLayout() {
  const navigate = useNavigate();
  const { webmcpEnabled } = useBranding();
  const [composeOpen, setComposeOpen] = useState(false);
  // Optional seed values for the compose drawer — populated when the user
  // opts into the "full compose" flow from inside a chat thread.
  const [composePrefill, setComposePrefill] = useState<ComposePrefill | null>(
    null,
  );
  const ui = useUiTheme();

  const openCompose = useCallback((prefill?: ComposePrefill) => {
    setComposePrefill(prefill ?? null);
    setComposeOpen(true);
  }, []);

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposePrefill(null);
  }, []);

  return (
    <WebMcpBridgeProvider navigate={navigate} openCompose={openCompose}>
      {webmcpEnabled && <WebMcpTools />}
      {ui === "default" ? (
        <>
          <PortalShell onCompose={() => openCompose()}>
            <Outlet context={{ onCompose: openCompose }} />
          </PortalShell>

          <ComposeFab onClick={() => openCompose()} />

          <ComposeModal
            open={composeOpen}
            onClose={closeCompose}
            prefill={composePrefill}
            onReopen={openCompose}
          />

          <Toaster />
        </>
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
          <ComposeModal
            open={composeOpen}
            onClose={closeCompose}
            prefill={composePrefill}
            onReopen={openCompose}
          />
          <Toaster />
        </Suspense>
      )}
    </WebMcpBridgeProvider>
  );
}
