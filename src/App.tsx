import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useNavigate,
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

/**
 * Listens for `saasmail.notificationclick` messages posted by the service
 * worker (public/sw.js) when a user clicks a Web Push notification while a
 * tab is already open. The SW focuses the tab and posts the target URL; we
 * complete the deep link by performing a client-side navigation here.
 */
function NotificationClickListener() {
  const navigate = useNavigate();
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
      return;
    function onMessage(e: MessageEvent) {
      const data = e.data;
      if (
        data &&
        data.type === "saasmail.notificationclick" &&
        typeof data.url === "string"
      ) {
        navigate(data.url);
      }
    }
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [navigate]);
  return null;
}

function App() {
  return (
    <BrandingProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <NotificationClickListener />
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
                {/* Deep link from Web Push notifications — see
                    worker/src/do/notifications.ts where data.url is set. */}
                <Route path="/inbox/:inbox/:personId" element={<InboxPage />} />
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
