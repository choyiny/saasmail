import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { signIn } from "@/lib/auth-client";
import { validateInvite, acceptInvite } from "@/lib/api";
import { WordmarkLarge } from "@/components/Wordmark";
import { useBranding } from "@/lib/branding";

export default function InviteAcceptPage() {
  const { passkeyRequired, brandName } = useBranding();
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<"loading" | "valid" | "invalid">(
    "loading",
  );
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus("invalid");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const info = await validateInvite(token);
        if (cancelled) return;
        if (info.valid) {
          setStatus("valid");
          if (info.email) {
            setInviteEmail(info.email);
            setEmail(info.email);
          }
        } else {
          setStatus("invalid");
        }
      } catch {
        if (!cancelled) setStatus("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const result = await acceptInvite({ token, name, email, password });
      if (!result.success) {
        setError("Failed to create account");
        return;
      }
      const signInResult = await signIn.email({ email, password });
      if (signInResult.error) {
        setError("Account created but sign-in failed. Please go to login.");
        return;
      }
      // Redirect home regardless of passkey gating; the auth guard will
      // bounce to /setup-passkey if needed once the session is loaded.
      // This avoids a race where /api/config hasn't responded yet and we
      // end up stuck on /invite/ while passkeyRequired flips.
      void passkeyRequired;
      window.location.href = "/";
    } catch (err: any) {
      setError(err?.message || "Failed to accept invitation");
    } finally {
      setLoading(false);
    }
  }

  if (status === "loading") {
    return <p className="text-sm text-chrome-dim">Validating invitation…</p>;
  }

  if (status === "invalid") {
    return (
      <div className="flex w-full max-w-[420px] flex-col items-center gap-7">
        <WordmarkLarge />
        <div className="pt-auth-card">
          <h2 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-text-primary">
            Invalid invitation
          </h2>
          <p className="mt-3 text-[13.5px] leading-relaxed text-text-secondary">
            This invitation link is invalid, expired, or has already been used.
          </p>
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
            Join {brandName}
          </h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-text-secondary">
            Create your account to get started.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="invite-name"
              className="text-[13px] font-medium text-text-primary"
            >
              Name
            </label>
            <input
              id="invite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
              className={INPUT_CLASS}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="invite-email"
              className="text-[13px] font-medium text-text-primary"
            >
              Email
            </label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              disabled={!!inviteEmail}
              className={INPUT_CLASS + (inviteEmail ? " opacity-60" : "")}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="invite-password"
              className="text-[13px] font-medium text-text-primary"
            >
              Password
            </label>
            <input
              id="invite-password"
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
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}

const INPUT_CLASS =
  "flex h-10 w-full rounded-lg border border-border-strong bg-card px-3 text-sm text-text-primary shadow-card transition-[border-color,box-shadow] placeholder:text-text-tertiary hover:border-text-tertiary/60 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:cursor-not-allowed";
