import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signIn } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBranding } from "@/lib/branding";

type Status = "checking" | "available" | "unavailable";

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { appName } = useBranding();
  const [status, setStatus] = useState<Status>("checking");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup/status");
        const data = (await res.json()) as { setupRequired: boolean };
        if (cancelled) return;
        setStatus(data.setupRequired ? "available" : "unavailable");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || "Setup failed");
        if (res.status === 403) setStatus("unavailable");
        return;
      }
      const result = await signIn.emailAndPassword({ email, password });
      if (result.error) {
        navigate("/login", { replace: true });
        return;
      }
      window.location.href = "/setup-passkey";
    } catch {
      setError("Setup failed");
    } finally {
      setLoading(false);
    }
  }

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-subtle">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-subtle">
        <Card className="w-full max-w-sm border-border bg-white ring-1 ring-gray-200 rounded-xl">
          <CardHeader>
            <CardTitle className="text-xl text-text-primary">
              Setup complete
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-text-secondary">
              An administrator account already exists. Please sign in instead.
            </p>
            <button
              className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover"
              onClick={() => navigate("/login")}
            >
              Go to sign in
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const inputClass =
    "h-8 w-full rounded-md border border-border bg-white ring-1 ring-gray-200 px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-subtle">
      <Card className="w-full max-w-sm border-border bg-white ring-1 ring-gray-200 rounded-xl">
        <CardHeader>
          <CardTitle className="text-xl text-text-primary">
            Welcome to {appName}
          </CardTitle>
          <p className="text-xs text-text-secondary">
            Create the first administrator account to get started.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className={inputClass}
              />
              <p className="text-[10px] text-text-tertiary">
                At least 8 characters.
              </p>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              disabled={loading}
            >
              {loading ? "Creating account..." : "Create administrator"}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
