import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { authClient } from "@/lib/auth-client";

export default function ConsentPage() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"allowed" | "denied" | null>(null);

  const clientId = searchParams.get("client_id");
  const scope = searchParams.get("scope") ?? "";

  const scopeDescriptions: Record<string, string> = {
    openid: "Access your user ID",
    profile: "Access your name and profile",
    email: "Access your email address",
    "email:read": "Read your emails and senders",
    "email:send": "Send and reply to emails",
    "email:manage": "Mark emails read/unread and delete emails",
    offline_access: "Stay connected (refresh tokens)",
  };

  const scopes = scope.split(" ").filter(Boolean);

  async function handleConsent(accept: boolean) {
    setLoading(accept ? "allow" : "deny");
    setError(null);

    try {
      // The oauthProviderClient plugin automatically injects oauth_query
      // from window.location.search into the request body.
      const res = (await authClient.$fetch("/oauth2/consent", {
        method: "POST",
        body: { accept },
      })) as { data?: { redirect?: boolean; url?: string } };

      if (res.data?.url) {
        setResult(accept ? "allowed" : "denied");
        window.location.href = res.data.url;
      } else {
        setResult(accept ? "allowed" : "denied");
      }
    } catch (err: any) {
      setError(err.message || "Failed to process consent.");
      setLoading(null);
    }
  }

  // Invalid request (missing params)
  if (!clientId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-main">
        <div className="w-full max-w-sm rounded-xl border border-border-dark bg-card p-6 text-center">
          <p className="text-sm text-red-400">Invalid authorization request.</p>
          <p className="mt-2 text-xs text-text-tertiary">
            This authorization request is invalid or has expired.
          </p>
        </div>
      </div>
    );
  }

  // Post-consent result screen
  if (result) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-main">
        <div className="w-full max-w-sm rounded-xl border border-border-dark bg-card p-6 text-center">
          {result === "allowed" ? (
            <>
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-900/30 text-2xl text-green-400">
                &#10003;
              </div>
              <h2 className="text-lg font-semibold text-text-primary">
                Access Granted
              </h2>
              <p className="mt-2 text-xs text-text-secondary">
                Authorization was successful. You can close this window.
              </p>
            </>
          ) : (
            <>
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-900/30 text-2xl text-text-tertiary">
                &#10005;
              </div>
              <h2 className="text-lg font-semibold text-text-primary">
                Access Denied
              </h2>
              <p className="mt-2 text-xs text-text-secondary">
                Authorization was denied. You can close this window.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  // Error screen
  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-main">
        <div className="w-full max-w-sm rounded-xl border border-border-dark bg-card p-6 text-center">
          <h2 className="text-lg font-semibold text-text-primary">
            Authorization Failed
          </h2>
          <p className="mt-2 text-xs text-red-400">{error}</p>
          <button
            onClick={() => {
              setError(null);
              setLoading(null);
            }}
            className="mt-4 rounded-md border border-border-dark px-4 py-2 text-sm text-text-secondary hover:bg-hover"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // Main consent screen
  return (
    <div className="flex min-h-screen items-center justify-center bg-main">
      <div className="w-full max-w-sm rounded-xl border border-border-dark bg-card p-6">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent/20 text-lg font-bold text-accent">
            c
          </div>
          <h1 className="text-lg font-semibold text-text-primary">
            Authorize Application
          </h1>
          <p className="mt-1 text-xs text-text-secondary">
            An application is requesting access to your cmail account.
          </p>
        </div>

        <div className="mb-4 text-center">
          <span className="inline-block rounded-md bg-main px-3 py-1.5 font-mono text-[11px] text-text-tertiary">
            {clientId}
          </span>
        </div>

        <div className="mb-6">
          <p className="mb-2 text-xs font-medium text-text-secondary">
            This application would like to:
          </p>
          <ul className="space-y-2">
            {scopes.map((s) => (
              <li
                key={s}
                className="flex items-start gap-2 rounded-md border border-border-dark bg-main px-3 py-2"
              >
                <span className="mt-0.5 text-green-400">&#10003;</span>
                <span className="text-xs text-text-primary">
                  {scopeDescriptions[s] ?? s}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => handleConsent(false)}
            disabled={loading !== null}
            className="flex-1 rounded-md border border-border-dark px-4 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
          >
            {loading === "deny" ? "Denying..." : "Deny"}
          </button>
          <button
            onClick={() => handleConsent(true)}
            disabled={loading !== null}
            className="flex-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {loading === "allow" ? "Authorizing..." : "Authorize"}
          </button>
        </div>

        <p className="mt-4 text-center text-[11px] text-text-tertiary">
          You can revoke this access at any time from your API Keys page.
        </p>
      </div>
    </div>
  );
}
