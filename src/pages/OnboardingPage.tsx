import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "@/lib/auth-client";
import { WordmarkLarge } from "@/components/Wordmark";
import { useBranding } from "@/lib/branding";

type Status = "checking" | "available" | "unavailable" | "migration-required";

type SetupStatusResponse = {
  setupRequired?: boolean;
  codeRequired?: boolean;
  error?: string;
  code?: string;
  command?: string;
};

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { passkeyRequired } = useBranding();
  const [status, setStatus] = useState<Status>("checking");
  const [codeRequired, setCodeRequired] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [migrationRequired, setMigrationRequired] =
    useState<SetupStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup/status");
        const data = (await res.json()) as SetupStatusResponse;
        if (cancelled) return;
        if (!res.ok && data.code === "DATABASE_MIGRATION_REQUIRED") {
          setMigrationRequired(data);
          setStatus("migration-required");
          return;
        }
        setCodeRequired(data.codeRequired === true);
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
        body: JSON.stringify({
          name,
          email,
          password,
          ...(codeRequired ? { code: code.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res
          .json()
          .catch(() => ({}))) as SetupStatusResponse;
        setError(data.error || "Setup failed");
        if (res.status === 503 && data.code === "DATABASE_MIGRATION_REQUIRED") {
          setMigrationRequired(data);
          setStatus("migration-required");
        }
        if (res.status === 403) setStatus("unavailable");
        return;
      }
      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        navigate("/login", { replace: true });
        return;
      }
      window.location.href = passkeyRequired ? "/setup-passkey" : "/";
    } catch {
      setError("Setup failed");
    } finally {
      setLoading(false);
    }
  }

  if (status === "checking") {
    return <p className="text-sm text-chrome-dim">Loading…</p>;
  }

  if (status === "migration-required") {
    return (
      <div className="flex w-full max-w-[420px] flex-col items-center gap-7">
        <WordmarkLarge />
        <div className="pt-auth-card">
          <h2 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-text-primary">
            Database migration required
          </h2>
          <p className="mt-3 text-[13.5px] leading-relaxed text-text-secondary">
            {migrationRequired?.error ||
              "The production database has not been initialized yet."}
          </p>
          <div className="font-code mt-5 rounded-lg border border-border bg-bg-subtle px-3 py-2 text-xs text-text-primary">
            {migrationRequired?.command || "yarn db:migrate:prod"}
          </div>
          <p className="mt-4 text-xs text-text-tertiary">
            To continue setup, run{" "}
            <code className="font-code rounded bg-bg-muted px-1 py-0.5 text-text-primary">
              yarn saasmail install --resume
            </code>
            , then reload this page.
          </p>
        </div>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="flex w-full max-w-[420px] flex-col items-center gap-7">
        <WordmarkLarge />
        <div className="pt-auth-card">
          <h2 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-text-primary">
            Setup complete
          </h2>
          <p className="mt-3 text-[13.5px] leading-relaxed text-text-secondary">
            An administrator account already exists. Please sign in instead.
          </p>
          <button
            className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-[13.5px] font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => navigate("/login")}
          >
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-7">
      <WordmarkLarge />
      <div className="pt-auth-card">
        <div className="mb-6">
          <h2 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-text-primary">
            Welcome
          </h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-text-secondary">
            Create the first administrator account to get started.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          {codeRequired && (
            <div className="space-y-1.5">
              <label
                htmlFor="onboarding-code"
                className="text-[13px] font-medium text-text-primary"
              >
                Setup code
              </label>
              <input
                id="onboarding-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                className={INPUT_CLASS}
              />
              <p className="text-xs text-text-tertiary">
                Printed at the end of <code>yarn saasmail install</code>.
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <label
              htmlFor="onboarding-name"
              className="text-[13px] font-medium text-text-primary"
            >
              Name
            </label>
            <input
              id="onboarding-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
              className={INPUT_CLASS}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="onboarding-email"
              className="text-[13px] font-medium text-text-primary"
            >
              Email
            </label>
            <input
              id="onboarding-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className={INPUT_CLASS}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="onboarding-password"
              className="text-[13px] font-medium text-text-primary"
            >
              Password
            </label>
            <input
              id="onboarding-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className={INPUT_CLASS}
            />
            <p className="text-xs text-text-tertiary">At least 8 characters.</p>
          </div>
          {error && (
            <p
              className="rounded-lg border border-destructive/25 bg-destructive-subtle px-3 py-2 text-[13px] text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-[13.5px] font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading}
          >
            {loading ? "Creating account…" : "Create administrator"}
          </button>
        </form>
      </div>
    </div>
  );
}

const INPUT_CLASS =
  "flex h-10 w-full rounded-lg border border-border-strong bg-card px-3 text-sm text-text-primary shadow-card transition-[border-color,box-shadow] placeholder:text-text-tertiary hover:border-text-tertiary/60 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:cursor-not-allowed";
