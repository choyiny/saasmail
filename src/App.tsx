import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
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
import AdminUsersPage from "@/pages/AdminUsersPage";

const queryClient = new QueryClient();

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const [passkeyStatus, setPasskeyStatus] = useState<boolean | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchPasskeyStatus().then((res) => {
      if (!cancelled) setPasskeyStatus(res.hasPasskey);
    }).catch(() => {
      if (!cancelled) setPasskeyStatus(false);
    });
    return () => { cancelled = true; };
  }, [session]);

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (passkeyStatus === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  if (!passkeyStatus) {
    return <Navigate to="/setup-passkey" replace />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
          <Route path="/setup-passkey" element={<SetupPasskeyPage />} />
          <Route
            path="/admin/users"
            element={
              <AuthGuard>
                <AdminUsersPage />
              </AuthGuard>
            }
          />
          <Route
            path="/templates"
            element={
              <AuthGuard>
                <TemplatesPage />
              </AuthGuard>
            }
          />
          <Route
            path="/templates/new"
            element={
              <AuthGuard>
                <TemplateEditorPage />
              </AuthGuard>
            }
          />
          <Route
            path="/templates/:slug/edit"
            element={
              <AuthGuard>
                <TemplateEditorPage />
              </AuthGuard>
            }
          />
          <Route
            path="/*"
            element={
              <AuthGuard>
                <InboxPage />
              </AuthGuard>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
