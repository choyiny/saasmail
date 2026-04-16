import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { authClient } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBranding } from "@/lib/branding";

export default function LoginPage() {
  const { appName } = useBranding();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"passkey" | "password">("passkey");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [searchParams] = useSearchParams();

  // If the login page was opened as part of an OAuth authorize flow, Better
  // Auth passes the original authorize params (response_type, client_id, etc.)
  // as query parameters. After a successful login we need to redirect back to
  // the authorize endpoint with those params so the flow can continue.
  function getPostLoginRedirect(): string {
    const responseType = searchParams.get("response_type");
    if (responseType) {
      // Rebuild the authorize URL with all query params
      const params = new URLSearchParams(searchParams);
      return `/api/auth/oauth2/authorize?${params.toString()}`;
    }
    return "/";
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup/status");
        const data = (await res.json()) as { setupRequired: boolean };
        if (!cancelled) setSetupRequired(data.setupRequired);
      } catch {
        if (!cancelled) setSetupRequired(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (setupRequired === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-main">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  if (setupRequired) {
    return <Navigate to="/onboarding" replace />;
  }

  async function handlePasskeyLogin() {
    setLoading(true);
    setError("");
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        setError(result.error.message || "Passkey sign-in failed");
      } else {
        window.location.href = getPostLoginRedirect();
      }
    } catch {
      setError("Passkey sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await authClient.signIn.email({
        email,
        password,
      });
      if (result?.error) {
        setError(result.error.message || "Sign-in failed");
      } else {
        window.location.href = getPostLoginRedirect();
      }
    } catch {
      setError("Sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-main">
      <Card className="w-full max-w-sm border-border-dark bg-card">
        <CardHeader>
          <CardTitle className="text-xl text-text-primary">{appName}</CardTitle>
          <p className="text-xs text-text-secondary">Sign in to continue.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-xs text-destructive">{error}</p>}
          {mode === "passkey" ? (
            <>
              <button
                className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                onClick={handlePasskeyLogin}
                disabled={loading}
              >
                {loading ? "Signing in..." : "Sign in with Passkey"}
              </button>
              <button
                className="w-full text-xs text-text-secondary hover:text-text-primary"
                onClick={() => {
                  setError("");
                  setMode("password");
                }}
                type="button"
              >
                Sign in with email instead
              </button>
            </>
          ) : (
            <form onSubmit={handlePasswordLogin} className="space-y-3">
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-border-dark bg-main px-3 py-2 text-xs text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
                required
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-border-dark bg-main px-3 py-2 text-xs text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
                required
              />
              <button
                type="submit"
                className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                disabled={loading}
              >
                {loading ? "Signing in..." : "Sign in"}
              </button>
              <button
                className="w-full text-xs text-text-secondary hover:text-text-primary"
                onClick={() => {
                  setError("");
                  setMode("passkey");
                }}
                type="button"
              >
                Sign in with passkey instead
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
