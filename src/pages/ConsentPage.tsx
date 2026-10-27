import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Check, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";
import { WordmarkLarge } from "@/components/Wordmark";

/**
 * Copy shown for each scope on the authorization screen. Anything not listed
 * falls back to the raw scope string rather than being hidden — a user must
 * never approve a permission we failed to describe.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Verify your identity",
  profile: "Read your name and profile details",
  email: "Read your email address",
  offline_access: "Stay connected when you are not using the app",
  "email:read": "Read your mail, contacts, and templates",
  "email:send": "Send mail and enroll contacts in sequences",
  "email:manage": "Mark mail as read and delete mail",
};

/**
 * Scopes that let a client act, not just look. An assistant connected to a
 * mailbox reads attacker-authored content by definition, so granting these
 * alongside read access is what turns a prompt injection into an outbound
 * message or a deletion. They are called out rather than listed flatly.
 */
const ELEVATED_SCOPES = new Set(["email:send", "email:manage"]);

const CARD = "pt-auth-card";

export default function ConsentPage() {
  const { brandName } = useBranding();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"allowed" | "denied" | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);

  const clientId = searchParams.get("client_id");
  const scopes = (searchParams.get("scope") ?? "").split(" ").filter(Boolean);

  // Show the registered application name rather than an opaque client id —
  // a user cannot make a meaningful trust decision about a random string.
  // Clients self-register, so treat the name as untrusted display text.
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = (await authClient.$fetch(
          `/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
          { method: "GET" },
        )) as { data?: { name?: string; client_name?: string } };
        const name = res.data?.name ?? res.data?.client_name;
        if (!cancelled && name) setClientName(name);
      } catch {
        // Fall back to the client id.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function handleConsent(accept: boolean) {
    setLoading(accept ? "allow" : "deny");
    setError(null);
    try {
      // oauthProviderClient injects `oauth_query` from window.location.search;
      // the endpoint verifies its signature and rebuilds the pending request.
      const res = (await authClient.$fetch("/oauth2/consent", {
        method: "POST",
        body: { accept },
      })) as { data?: { redirect?: boolean; url?: string } };

      if (res.data?.url) {
        window.location.href = res.data.url;
        return;
      }
      setResult(accept ? "allowed" : "denied");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to process consent.",
      );
      setLoading(null);
    }
  }

  if (!clientId) {
    return (
      <div className="flex w-full max-w-[420px] flex-col items-center gap-7">
        <WordmarkLarge />
        <div className={`${CARD} text-center`}>
          <h1 className="text-[18px] font-semibold tracking-[-0.015em] text-text-primary">
            Invalid request
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
            This authorization request is missing information or has expired.
            Start again from the application you were connecting.
          </p>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="flex w-full max-w-[420px] flex-col items-center gap-7">
        <WordmarkLarge />
        <div className={`${CARD} text-center`}>
          <h1 className="text-[18px] font-semibold tracking-[-0.015em] text-text-primary">
            {result === "allowed" ? "Access granted" : "Access denied"}
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
            You can close this window and return to the application.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-7">
      <WordmarkLarge />
      <div className={CARD}>
        <div className="mb-6">
          <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-subtle text-accent-subtle-fg">
            <ShieldCheck className="h-5 w-5" strokeWidth={2} aria-hidden />
          </span>
          <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-text-primary">
            Authorize access
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">
              {clientName ?? clientId}
            </span>{" "}
            wants access to your {brandName} account.
          </p>
          {clientName && (
            <p className="font-code mt-1 text-[11px] text-text-tertiary">
              {clientId}
            </p>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-destructive/25 bg-destructive-subtle px-3 py-2 text-[13px] text-destructive"
          >
            {error}
          </p>
        )}

        <p className="font-label mb-2 text-text-tertiary">It will be able to</p>
        <ul className="mb-4 space-y-2">
          {scopes.map((s) => {
            const elevated = ELEVATED_SCOPES.has(s);
            return (
              <li
                key={s}
                className={
                  elevated
                    ? "flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2"
                    : "flex items-start gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2"
                }
              >
                {elevated ? (
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
                    strokeWidth={2.5}
                    aria-hidden
                  />
                ) : (
                  <Check
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success"
                    strokeWidth={2.5}
                    aria-hidden
                  />
                )}
                <span
                  className={
                    elevated
                      ? "text-[13px] text-warning-text"
                      : "text-[13px] text-text-primary"
                  }
                >
                  {SCOPE_DESCRIPTIONS[s] ?? s}
                </span>
              </li>
            );
          })}
        </ul>

        {scopes.some((s) => ELEVATED_SCOPES.has(s)) && (
          <p className="mb-6 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs leading-relaxed text-warning-text">
            This app can act on your mailbox, not just read it. Anything it
            reads — including mail sent to you by strangers — can influence what
            it does next. Only continue if you trust it with sending and
            deleting.
          </p>
        )}

        <div className="space-y-2.5">
          <button
            type="button"
            onClick={() => handleConsent(true)}
            disabled={loading !== null}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-[13.5px] font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading === "allow" ? "Authorizing…" : "Authorize"}
          </button>
          <button
            type="button"
            onClick={() => handleConsent(false)}
            disabled={loading !== null}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-card px-4 text-[13.5px] font-medium text-text-primary shadow-card ring-1 ring-inset ring-border-strong transition-colors hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading === "deny" ? "Denying…" : "Deny"}
          </button>
        </div>

        <p className="mt-6 border-t border-border pt-4 text-center text-xs text-text-tertiary">
          Only authorize applications you trust. You can revoke access later.
        </p>
      </div>
    </div>
  );
}
