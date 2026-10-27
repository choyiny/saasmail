import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Mail, Fingerprint, ArrowRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthCard, AuthError } from "@/components/Wordmark";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"passkey" | "password">("passkey");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

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
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="animate-pulse text-sm text-chrome-dim">Loading…</p>
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
        window.location.href = "/";
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
      const result = await authClient.signIn.email({ email, password });
      if (result?.error) {
        setError(result.error.message || "Sign-in failed");
      } else {
        window.location.href = "/";
      }
    } catch {
      setError("Sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard title="Sign in" subtitle="One unified timeline per customer.">
      {error && <AuthError>{error}</AuthError>}

      {mode === "passkey" ? (
        <div className="space-y-2.5">
          <Button
            type="button"
            size="lg"
            onClick={handlePasskeyLogin}
            disabled={loading}
            className="w-full"
          >
            <Fingerprint strokeWidth={2.25} />
            {loading ? "Signing in…" : "Continue with passkey"}
          </Button>

          <Button
            type="button"
            size="lg"
            variant="outline"
            onClick={() => {
              setError("");
              setMode("password");
            }}
            className="w-full"
          >
            <Mail strokeWidth={2.25} />
            Sign in with email instead
          </Button>
        </div>
      ) : (
        <form onSubmit={handlePasswordLogin} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              placeholder="Email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="h-10"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="h-10"
            />
          </div>
          <Button type="submit" size="lg" disabled={loading} className="w-full">
            {loading ? (
              "Signing in…"
            ) : (
              <>
                <span>Sign in</span>
                <ArrowRight strokeWidth={2.25} aria-hidden />
              </>
            )}
          </Button>
          <button
            type="button"
            onClick={() => {
              setError("");
              setMode("passkey");
            }}
            className="block w-full text-center text-[13px] text-text-secondary transition-colors hover:text-text-primary"
          >
            Sign in with passkey instead
          </button>
        </form>
      )}

      <p className="mt-6 border-t border-border pt-4 text-center text-xs text-text-tertiary">
        By signing in, you agree to our{" "}
        <a
          href="/terms"
          className="font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
        >
          Terms of Service
        </a>
      </p>
    </AuthCard>
  );
}
