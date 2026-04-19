import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchApiKeyInfo, generateApiKey, revokeApiKey } from "@/lib/api";
import type { ApiKeyInfo } from "@/lib/api";

export default function ApiKeysPage() {
  const [keyInfo, setKeyInfo] = useState<ApiKeyInfo | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<
    "regenerate" | "revoke" | null
  >(null);

  useEffect(() => {
    fetchApiKeyInfo()
      .then((keyRes) => {
        setKeyInfo(keyRes.key);
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
                data-testid="api-key-revealed"
                value={newKey}
                className="h-8 flex-1 rounded-md border border-border bg-white ring-1 ring-gray-200 px-3 font-mono text-xs text-text-primary focus:outline-none"
              />
              <button
                onClick={handleCopy}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary"
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
          <div className="mb-6 rounded-lg border border-border bg-white ring-1 ring-gray-200 px-4 py-3">
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
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                >
                  Regenerate
                </button>
                <button
                  onClick={() => setConfirmAction("revoke")}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-destructive hover:bg-bg-muted"
                >
                  Revoke
                </button>
              </div>
            </div>
          </div>
        )}

        {!keyInfo && !newKey && (
          <div className="mb-6 rounded-lg border border-border bg-white ring-1 ring-gray-200 px-4 py-4 text-center">
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

        <div className="mb-6 rounded-lg border border-border bg-white ring-1 ring-gray-200 p-4">
          <h2 className="mb-2 text-xs font-semibold text-text-primary">
            API Key Usage
          </h2>
          <p className="mb-2 text-xs text-text-secondary">
            Include your API key in the{" "}
            <code className="text-accent">Authorization</code> header:
          </p>
          <pre className="rounded bg-bg-subtle p-3 text-[11px] text-text-secondary">
            {`curl -H "Authorization: Bearer sk_..." \\
  ${window.location.origin}/api/people`}
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

        {/* Confirmation Dialog */}
        <Dialog
          open={confirmAction !== null}
          onOpenChange={() => setConfirmAction(null)}
        >
          <DialogContent className="border-border bg-white ring-1 ring-gray-200 text-text-primary">
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
                className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary"
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
