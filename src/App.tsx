import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrandingProvider, useBranding } from "@/lib/branding";
import { useSession } from "@/lib/auth-client";
import { fetchPasskeyStatus } from "@/lib/api";
import { useEffect, useState } from "react";
import LoginPage from "@/pages/LoginPage";
import OnboardingPage from "@/pages/OnboardingPage";
import InboxPage from "@/pages/InboxPage";
import TemplatesPage from "@/pages/TemplatesPage";
import TemplateEditorPage from "@/pages/TemplateEditorPage";
import SetupPasskeyPage from "@/pages/SetupPasskeyPage";
import InviteAcceptPage from "@/pages/InviteAcceptPage";
import AdminUsersPage from "@/pages/AdminUsersPage";
import ApiKeysPage from "@/pages/ApiKeysPage";
import DashboardLayout from "@/components/DashboardLayout";
import SequencesPage from "@/pages/SequencesPage";
import SequenceDetailPage from "@/pages/SequenceDetailPage";
import SequenceEditorPage from "@/pages/SequenceEditorPage";
import InboxesPage from "./pages/InboxesPage";
import NotificationsSettingsPage from "@/pages/NotificationsSettingsPage";
import AgentsPage from "./pages/AgentsPage";
import AgentEditorPage from "./pages/AgentEditorPage";
import AgentDetailPage from "./pages/AgentDetailPage";
import AgentRunsPage from "./pages/AgentRunsPage";
import DraftsPage from "./pages/DraftsPage";

const queryClient = new QueryClient();

function AuthGuard() {
  const { data: session, isPending } = useSession();
  const { passkeyRequired, loaded: brandingLoaded } = useBranding();
  const [passkeyStatus, setPasskeyStatus] = useState<boolean | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchPasskeyStatus()
      .then((res) => {
        if (!cancelled) setPasskeyStatus(res.hasPasskey);
      })
      .catch(() => {
        if (!cancelled) setPasskeyStatus(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (
    isPending ||
    (session && passkeyStatus === null) ||
    (session && !brandingLoaded)
  ) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  // Passkey enforcement is gated by the server (demo/dev deploys disable it).
  // `passkeyRequired` reflects the backend's runtime decision so frontend and
  // backend always agree.
  if (!passkeyStatus && passkeyRequired) {
    return <Navigate to="/setup-passkey" replace />;
  }

  return <Outlet />;
}

function App() {
  return (
    <BrandingProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/invite/:token" element={<InviteAcceptPage />} />
            <Route path="/setup-passkey" element={<SetupPasskeyPage />} />

            {/* Authenticated routes with shared layout */}
            <Route element={<AuthGuard />}>
              <Route element={<DashboardLayout />}>
                <Route path="/admin/users" element={<AdminUsersPage />} />
                <Route path="/templates" element={<TemplatesPage />} />
                <Route path="/templates/new" element={<TemplateEditorPage />} />
                <Route
                  path="/templates/:slug/edit"
                  element={<TemplateEditorPage />}
                />
                <Route path="/sequences" element={<SequencesPage />} />
                <Route path="/sequences/new" element={<SequenceEditorPage />} />
                <Route
                  path="/sequences/:id/edit"
                  element={<SequenceEditorPage />}
                />
                <Route path="/sequences/:id" element={<SequenceDetailPage />} />
                <Route path="/api-keys" element={<ApiKeysPage />} />
                <Route path="/inboxes" element={<InboxesPage />} />
                <Route
                  path="/settings"
                  element={<NotificationsSettingsPage />}
                />
                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/agents/new" element={<AgentEditorPage />} />
                <Route path="/agents/runs" element={<AgentRunsPage />} />
                <Route path="/agents/:id" element={<AgentDetailPage />} />
                <Route path="/agents/:id/edit" element={<AgentEditorPage />} />
                <Route path="/drafts" element={<DraftsPage />} />
                <Route path="/*" element={<InboxPage />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </BrandingProvider>
  );
}

export default App;
