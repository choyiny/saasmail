import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import ConsentPage from "@/pages/ConsentPage";
import AdminUsersPage from "@/pages/AdminUsersPage";
import ApiKeysPage from "@/pages/ApiKeysPage";
import DashboardLayout from "@/components/DashboardLayout";
import SequencesPage from "@/pages/SequencesPage";
import SequenceDetailPage from "@/pages/SequenceDetailPage";
import SequenceEditorPage from "@/pages/SequenceEditorPage";

const queryClient = new QueryClient();

function AuthGuard() {
  const { data: session, isPending } = useSession();
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

  if (isPending || (session && passkeyStatus === null)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-main">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (!passkeyStatus) {
    return <Navigate to="/setup-passkey" replace />;
  }

  return <Outlet />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
          <Route path="/setup-passkey" element={<SetupPasskeyPage />} />
          <Route path="/consent" element={<ConsentPage />} />

          {/* Authenticated routes with shared layout */}
          <Route element={<AuthGuard />}>
            <Route element={<DashboardLayout />}>
              <Route path="/admin/users" element={<AdminUsersPage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/templates/new" element={<TemplateEditorPage />} />
              <Route path="/templates/:slug/edit" element={<TemplateEditorPage />} />
              <Route path="/sequences" element={<SequencesPage />} />
              <Route path="/sequences/new" element={<SequenceEditorPage />} />
              <Route path="/sequences/:id/edit" element={<SequenceEditorPage />} />
              <Route path="/sequences/:id" element={<SequenceDetailPage />} />
              <Route path="/api-keys" element={<ApiKeysPage />} />
              <Route path="/*" element={<InboxPage />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
