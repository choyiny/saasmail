import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fetchApiKeyInfo,
  generateApiKey,
  revokeApiKey,
  fetchOAuthApps,
  revokeOAuthApp,
} from "@/lib/api";
import type { ApiKeyInfo, OAuthApp } from "@/lib/api";

export default function ApiKeysPage() {
  const [keyInfo, setKeyInfo] = useState<ApiKeyInfo | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<
    "regenerate" | "revoke" | null
  >(null);
  const [oauthApps, setOauthApps] = useState<OAuthApp[]>([]);
  const [copied, setCopied] = useState(false);

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        cmail: {
          url: `${window.location.origin}/mcp`,
          auth: "oauth",
        },
      },
    },
    null,
    2,
  );

  useEffect(() => {
    Promise.all([fetchApiKeyInfo(), fetchOAuthApps()])
      .then(([keyRes, apps]) => {
        setKeyInfo(keyRes.key);
        setOauthApps(apps);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleGenerate() {
    const res = await generateApiKey();
    setNewKey(res.key);
    setKeyInfo({ prefix: res.prefix, createdAt: res.createdAt });
    setConfirmAction(null);
  }

  async function handleRevoke() {
    await revokeApiKey();
    setKeyInfo(null);
    setNewKey(null);
    setConfirmAction(null);
  }

  function handleCopy() {
    if (newKey) navigator.clipboard.writeText(newKey);
  }

  function handleCopyConfig() {
    navigator.clipboard.writeText(mcpConfig);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRevokeApp(clientId: string) {
    if (!confirm("Revoke this application's access?")) return;
    await revokeOAuthApp(clientId);
    setOauthApps((prev) => prev.filter((a) => a.clientId !== clientId));
  }

  if (loading) {
    return (
      <div className="flex-1 p-6">
        <p className="text-xs text-text-tertiary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-6 text-sm font-semibold text-text-primary">
          API Access
        </h1>

        {/* --- API Keys Section --- */}
        {newKey && (
          <div className="mb-6 rounded-lg border border-warning-border bg-warning-bg px-4 py-3">
            <p className="mb-2 text-xs font-medium text-warning-text">
              Your API key (copy it now — it won't be shown again):
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={newKey}
                className="h-8 flex-1 rounded-md border border-border-dark bg-input-bg px-3 font-mono text-xs text-text-primary focus:outline-none"
              />
              <button
                onClick={handleCopy}
                className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
              >
                Copy
              </button>
            </div>
            <button
              onClick={() => setNewKey(null)}
              className="mt-2 text-xs text-text-tertiary hover:text-text-secondary"
            >
              Done
            </button>
          </div>
        )}

        {keyInfo && !newKey && (
          <div className="mb-6 rounded-lg border border-border-dark bg-card px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-mono text-xs text-text-primary">
                  {keyInfo.prefix}
                </p>
                <p className="text-[11px] text-text-tertiary">
                  Created{" "}
                  {new Date(keyInfo.createdAt * 1000).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmAction("regenerate")}
                  className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
                >
                  Regenerate
                </button>
                <button
                  onClick={() => setConfirmAction("revoke")}
                  className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-destructive hover:bg-hover"
                >
                  Revoke
                </button>
              </div>
            </div>
          </div>
        )}

        {!keyInfo && !newKey && (
          <div className="mb-6 rounded-lg border border-border-dark bg-card px-4 py-4 text-center">
            <p className="mb-3 text-xs text-text-tertiary">
              No API key generated yet.
            </p>
            <button
              onClick={handleGenerate}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
            >
              Generate API Key
            </button>
          </div>
        )}

        <div className="mb-6 rounded-lg border border-border-dark bg-card p-4">
          <h2 className="mb-2 text-xs font-semibold text-text-primary">
            API Key Usage
          </h2>
          <p className="mb-2 text-xs text-text-secondary">
            Include your API key in the{" "}
            <code className="text-accent">Authorization</code> header:
          </p>
          <pre className="rounded bg-sidebar p-3 text-[11px] text-text-secondary">
            {`curl -H "Authorization: Bearer sk_..." \\
  ${window.location.origin}/api/senders`}
          </pre>
          <p className="mt-2 text-xs text-text-secondary">
            The key grants full access to the API as your user account. See{" "}
            <a
              href="/swagger-ui"
              className="text-accent hover:text-accent-hover"
            >
              API docs
            </a>{" "}
            for available endpoints.
          </p>
        </div>

        {/* --- MCP Connection Section --- */}
        <h2 className="mb-4 mt-8 text-sm font-semibold text-text-primary">
          MCP Connection
        </h2>

        <div className="mb-6 rounded-lg border border-border-dark bg-card p-4">
          <h3 className="mb-2 text-xs font-semibold text-text-primary">
            Server URL
          </h3>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-sidebar px-3 py-2 text-xs text-text-primary">
              {window.location.origin}/mcp
            </code>
          </div>

          <h3 className="mb-2 mt-4 text-xs font-semibold text-text-primary">
            Claude Desktop Configuration
          </h3>
          <p className="mb-2 text-xs text-text-secondary">
            Add this to your{" "}
            <code className="text-accent">claude_desktop_config.json</code>:
          </p>
          <div className="relative">
            <pre className="rounded bg-sidebar p-3 text-[11px] text-text-secondary">
              {mcpConfig}
            </pre>
            <button
              onClick={handleCopyConfig}
              className="absolute right-2 top-2 rounded border border-border-dark px-2 py-1 text-[10px] text-text-tertiary hover:bg-hover hover:text-text-secondary"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-border-dark bg-card p-4">
          <h3 className="mb-3 text-xs font-semibold text-text-primary">
            Connected Applications
          </h3>
          {oauthApps.length === 0 ? (
            <p className="text-xs text-text-tertiary">
              Connect an MCP client using the URL above. Apps will appear here
              after authorization.
            </p>
          ) : (
            <div className="space-y-2">
              {oauthApps.map((app) => (
                <div
                  key={app.clientId}
                  className="flex items-center justify-between rounded-md border border-border-dark px-3 py-2"
                >
                  <div>
                    <p className="text-xs font-medium text-text-primary">
                      {app.name ?? "MCP Client"}
                    </p>
                    <p className="text-[11px] text-text-tertiary">
                      {app.clientId}
                    </p>
                  </div>
                  <button
                    onClick={() => handleRevokeApp(app.clientId)}
                    className="rounded-md border border-border-dark px-2 py-1 text-xs text-red-400 hover:bg-hover"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Confirmation Dialog */}
        <Dialog
          open={confirmAction !== null}
          onOpenChange={() => setConfirmAction(null)}
        >
          <DialogContent className="border-border-dark bg-card text-text-primary">
            <DialogHeader>
              <DialogTitle className="text-text-primary">
                {confirmAction === "regenerate"
                  ? "Regenerate API Key?"
                  : "Revoke API Key?"}
              </DialogTitle>
            </DialogHeader>
            <p className="text-xs text-text-secondary">
              {confirmAction === "regenerate"
                ? "This will invalidate your current key and generate a new one. Any integrations using the old key will stop working."
                : "This will permanently delete your API key. Any integrations using it will stop working."}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmAction(null)}
                className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={
                  confirmAction === "regenerate" ? handleGenerate : handleRevoke
                }
                className={`rounded-md px-3 py-1.5 text-xs font-medium text-white ${
                  confirmAction === "revoke"
                    ? "bg-destructive hover:bg-destructive/90"
                    : "bg-accent hover:bg-accent-hover"
                }`}
              >
                {confirmAction === "regenerate" ? "Regenerate" : "Revoke"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
