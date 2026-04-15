import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { authClient } from "@/lib/auth-client";

export default function ConsentPage() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientId = searchParams.get("client_id");
  const consentCode = searchParams.get("consent_code") ?? "";
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
    setLoading(true);
    setError(null);

    try {
      const res = await authClient.$fetch("/oauth2/consent", {
        method: "POST",
        body: { accept, consent_code: consentCode },
      }) as { data?: { redirectURI?: string } };

      if (res.data?.redirectURI) {
        window.location.href = res.data.redirectURI;
      }
    } catch (err: any) {
      setError(err.message || "Failed to process consent.");
      setLoading(false);
    }
  }

  if (!clientId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-main">
        <div className="w-full max-w-sm rounded-xl border border-border-dark bg-card p-6 text-center">
          <p className="text-sm text-red-400">Invalid authorization request.</p>
        </div>
      </div>
    );
  }

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

        {error && (
          <div className="mb-4 rounded-md bg-red-900/20 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

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
            disabled={loading}
            className="flex-1 rounded-md border border-border-dark px-4 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
          >
            Deny
          </button>
          <button
            onClick={() => handleConsent(true)}
            disabled={loading}
            className="flex-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {loading ? "Authorizing..." : "Authorize"}
          </button>
        </div>

        <p className="mt-4 text-center text-[11px] text-text-tertiary">
          You can revoke this access at any time from your API Keys page.
        </p>
      </div>
    </div>
  );
}
