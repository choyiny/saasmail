import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signIn } from "@/lib/auth-client";
import { WordmarkLarge } from "@/components/Wordmark";
import { useBranding } from "@/lib/branding";

type Status = "checking" | "available" | "unavailable" | "migration-required";

type SetupStatusResponse = {
  setupRequired?: boolean;
  error?: string;
  code?: string;
  command?: string;
};

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { passkeyRequired } = useBranding();
  const [status, setStatus] = useState<Status>("checking");
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
      const result = await signIn.emailAndPassword({ email, password });
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
    return <p className="text-sm text-white/60">Loading…</p>;
  }

  if (status === "migration-required") {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <WordmarkLarge />
        <div className="w-full rounded-2xl bg-white/10 p-8 shadow-2xl ring-1 ring-white/20 backdrop-blur-xl">
          <h2 className="text-xl font-extrabold tracking-tight text-white">
            Database migration required
          </h2>
          <p className="mt-3 text-sm font-light text-white/60">
            {migrationRequired?.error ||
              "The production database has not been initialized yet."}
          </p>
          <div className="mt-5 rounded-md bg-white/5 px-3 py-2 text-xs font-medium text-white ring-1 ring-white/15">
            {migrationRequired?.command || "yarn db:migrate:prod"}
          </div>
          <p className="mt-4 text-xs font-light text-white/40">
            For a guided first deploy, run{" "}
            <code className="rounded bg-white/10 px-1 py-0.5 text-white/70">
              /saasmail-onboarding
            </code>{" "}
            in Claude Code, then reload this page.
          </p>
        </div>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <WordmarkLarge />
        <div className="w-full rounded-2xl bg-white/10 p-8 shadow-2xl ring-1 ring-white/20 backdrop-blur-xl">
          <h2 className="text-xl font-extrabold tracking-tight text-white">
            Setup complete
          </h2>
          <p className="mt-3 text-sm font-light text-white/60">
            An administrator account already exists. Please sign in instead.
          </p>
          <button
            className="mt-6 w-full rounded-full bg-white py-2.5 text-sm font-medium text-[#0a0a0a] transition-colors hover:bg-white/90"
            onClick={() => navigate("/login")}
          >
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-8">
      <WordmarkLarge />
      <div className="w-full rounded-2xl bg-white/10 p-8 shadow-2xl ring-1 ring-white/20 backdrop-blur-xl">
        <div className="mb-6">
          <h2 className="text-xl font-extrabold tracking-tight text-white">
            Welcome
          </h2>
          <p className="mt-1.5 text-sm font-light text-white/60">
            Create the first administrator account to get started.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="onboarding-name"
              className="text-xs font-medium uppercase tracking-wider text-white/50"
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
              className="text-xs font-medium uppercase tracking-wider text-white/50"
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
              className="text-xs font-medium uppercase tracking-wider text-white/50"
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
            <p className="text-xs font-light text-white/40">
              At least 8 characters.
            </p>
          </div>
          {error && (
            <p className="text-sm text-red-300" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="w-full rounded-full bg-white py-2.5 text-sm font-medium text-[#0a0a0a] transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
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
  "h-10 w-full rounded-md border-0 bg-white/5 px-3 text-sm text-white ring-1 ring-white/15 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-white/40 transition-all";
