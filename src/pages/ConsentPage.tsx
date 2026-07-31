import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Check, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";

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

const CARD =
  "rounded-2xl bg-white/10 p-8 shadow-2xl ring-1 ring-white/20 backdrop-blur-xl";

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
      <div className="relative z-10 mx-4 w-full max-w-sm">
        <div className={`${CARD} text-center`}>
          <h1 className="text-lg font-semibold text-white">Invalid request</h1>
          <p className="mt-2 text-sm font-light text-white/50">
            This authorization request is missing information or has expired.
            Start again from the application you were connecting.
          </p>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="relative z-10 mx-4 w-full max-w-sm">
        <div className={`${CARD} text-center`}>
          <h1 className="text-lg font-semibold text-white">
            {result === "allowed" ? "Access granted" : "Access denied"}
          </h1>
          <p className="mt-2 text-sm font-light text-white/50">
            You can close this window and return to the application.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative z-10 mx-4 w-full max-w-sm">
      <div className={CARD}>
        <div className="mb-8 text-center">
          <ShieldCheck
            className="mx-auto mb-4 h-12 w-12"
            strokeWidth={2}
            style={{ color: "#BFFF00" }}
            aria-hidden
          />
          <h1 className="text-2xl font-extrabold uppercase tracking-tight text-white">
            Authorize
          </h1>
          <p className="mt-2 text-sm font-light text-white/50">
            <span className="font-medium text-white/80">
              {clientName ?? clientId}
            </span>{" "}
            wants access to your {brandName} account.
          </p>
          {clientName && (
            <p className="mt-1 font-mono text-[11px] text-white/30">
              {clientId}
            </p>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="mb-4 rounded-md bg-red-500/15 px-3 py-2 text-center text-xs text-red-200 ring-1 ring-red-500/25"
          >
            {error}
          </p>
        )}

        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-white/50">
          It will be able to
        </p>
        <ul className="mb-4 space-y-2">
          {scopes.map((s) => {
            const elevated = ELEVATED_SCOPES.has(s);
            return (
              <li
                key={s}
                className={
                  elevated
                    ? "flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 ring-1 ring-amber-400/30"
                    : "flex items-start gap-2 rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10"
                }
              >
                {elevated ? (
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300"
                    strokeWidth={2.5}
                    aria-hidden
                  />
                ) : (
                  <Check
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    strokeWidth={2.5}
                    style={{ color: "#BFFF00" }}
                    aria-hidden
                  />
                )}
                <span
                  className={
                    elevated
                      ? "text-xs text-amber-100"
                      : "text-xs text-white/80"
                  }
                >
                  {SCOPE_DESCRIPTIONS[s] ?? s}
                </span>
              </li>
            );
          })}
        </ul>

        {scopes.some((s) => ELEVATED_SCOPES.has(s)) && (
          <p className="mb-8 rounded-md bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100 ring-1 ring-amber-400/30">
            This app can act on your mailbox, not just read it. Anything it
            reads — including mail sent to you by strangers — can influence what
            it does next. Only continue if you trust it with sending and
            deleting.
          </p>
        )}

        <div className="space-y-3">
          <button
            type="button"
            onClick={() => handleConsent(true)}
            disabled={loading !== null}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading === "allow" ? "Authorizing…" : "Authorize"}
          </button>
          <button
            type="button"
            onClick={() => handleConsent(false)}
            disabled={loading !== null}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-[#24292f] px-4 text-sm font-semibold text-white ring-1 ring-white/15 transition-colors hover:bg-[#24292f]/80 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading === "deny" ? "Denying…" : "Deny"}
          </button>
        </div>

        <p className="mt-6 text-center text-[11px] font-light text-white/40">
          Only authorize applications you trust. You can revoke access later.
        </p>
      </div>
    </div>
  );
}
