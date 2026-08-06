import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Mail, Fingerprint, ArrowRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";

// Sign-in must hand a parked OAuth request back or the client hangs. Not an
// open redirect: always our own authorize endpoint, and the server re-verifies
// `sig`/`exp`.
function pendingAuthorizeUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("client_id") || !params.has("sig")) return null;
  return `/api/auth/oauth2/authorize${window.location.search}`;
}

export default function LoginPage() {
  const { brandName } = useBranding();
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
        <p className="animate-pulse text-sm text-white/40">Loading…</p>
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
        window.location.href = pendingAuthorizeUrl() ?? "/";
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
        window.location.href = pendingAuthorizeUrl() ?? "/";
      }
    } catch {
      setError("Sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative z-10 mx-4 w-full max-w-sm">
      <div className="rounded-2xl bg-white/10 p-8 shadow-2xl ring-1 ring-white/20 backdrop-blur-xl">
        {/* Brand block — matches givefeedback's auth layout exactly */}
        <div className="mb-8 text-center">
          <Mail
            className="mx-auto mb-4 h-12 w-12"
            strokeWidth={2}
            style={{ color: "#BFFF00" }}
            aria-hidden
          />
          <h1 className="text-2xl font-extrabold uppercase tracking-tight text-white">
            {brandName}
          </h1>
          <p className="mt-2 text-sm font-light text-white/50">
            One unified timeline per customer
          </p>
        </div>

        {error && (
          <p
            role="alert"
            className="text-destructive mb-4 rounded-md bg-red-500/15 px-3 py-2 text-center text-xs text-red-200 ring-1 ring-red-500/25"
          >
            {error}
          </p>
        )}

        {mode === "passkey" ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={handlePasskeyLogin}
              disabled={loading}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Fingerprint className="h-4 w-4" strokeWidth={2.25} />
              {loading ? "Signing in…" : "Continue with passkey"}
            </button>

            <button
              type="button"
              onClick={() => {
                setError("");
                setMode("password");
              }}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-[#24292f] px-4 text-sm font-semibold text-white ring-1 ring-white/15 transition-colors hover:bg-[#24292f]/80"
            >
              <Mail className="h-4 w-4" strokeWidth={2.25} />
              Sign in with email instead
            </button>
          </div>
        ) : (
          <form onSubmit={handlePasswordLogin} className="space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="login-email"
                className="text-[11px] font-medium uppercase tracking-wider text-white/50"
              >
                Email
              </label>
              <input
                id="login-email"
                type="email"
                placeholder="Email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className={INPUT_CLASS}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="login-password"
                className="text-[11px] font-medium uppercase tracking-wider text-white/50"
              >
                Password
              </label>
              <input
                id="login-password"
                type="password"
                placeholder="Password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className={INPUT_CLASS}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                "Signing in…"
              ) : (
                <>
                  <span>Sign in</span>
                  <ArrowRight
                    className="h-4 w-4"
                    strokeWidth={2.25}
                    aria-hidden
                  />
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setError("");
                setMode("passkey");
              }}
              className="block w-full text-center text-xs font-light text-white/50 transition-colors hover:text-white/80"
            >
              Sign in with passkey instead
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-xs font-light text-white/30">
          By signing in, you agree to our{" "}
          <a
            href="/terms"
            className="underline-offset-2 hover:text-white/60 hover:underline"
          >
            Terms of Service
          </a>
        </p>
      </div>
    </div>
  );
}

const INPUT_CLASS =
  "h-11 w-full rounded-md border-0 bg-white/5 px-3 text-sm text-white ring-1 ring-white/15 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-white/40";
