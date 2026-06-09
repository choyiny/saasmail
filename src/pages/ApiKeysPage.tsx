import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Copy, Check, Key, RefreshCw, Trash2 } from "lucide-react";
import {
  fetchApiKeyInfo,
  generateApiKey,
  revokeApiKey,
  fetchWebhookConfig,
  saveWebhookConfig,
  testWebhook,
} from "@/lib/api";
import type { ApiKeyInfo } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import PageHeader, { PageContainer } from "@/components/PageHeader";

export default function ApiKeysPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const [keyInfo, setKeyInfo] = useState<ApiKeyInfo | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    "regenerate" | "revoke" | null
  >(null);

  useEffect(() => {
    fetchApiKeyInfo()
      .then((keyRes) => setKeyInfo(keyRes.key))
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
    if (!newKey) return;
    navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <PageContainer>
      <PageHeader
        title="API keys"
        subtitle="Issue scoped API keys for programmatic access — send email, manage templates, enroll contacts, and query inbox data."
      />

      <div className="max-w-3xl space-y-5">
        {loading ? (
          <p className="text-sm font-light text-text-tertiary">Loading…</p>
        ) : (
          <>
            {/* Newly generated key — must copy now */}
            {newKey && (
              <div className="rounded-[8px] border border-warning-border bg-warning-bg px-4 py-3">
                <p className="mb-2 text-xs font-medium text-warning-text">
                  Your API key — copy it now, it won't be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    data-testid="api-key-revealed"
                    value={newKey}
                    className="h-9 flex-1 rounded-[6px] border border-border bg-card px-3 font-mono text-xs text-text-primary focus:outline-none"
                  />
                  <button
                    onClick={handleCopy}
                    className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-border px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                  >
                    {copied ? (
                      <>
                        <Check size={12} />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy size={12} />
                        Copy
                      </>
                    )}
                  </button>
                </div>
                <button
                  onClick={() => setNewKey(null)}
                  className="mt-2 text-xs font-light text-text-tertiary transition-colors hover:text-text-secondary"
                >
                  Done
                </button>
              </div>
            )}

            {/* Existing key */}
            {keyInfo && !newKey && (
              <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet/10 text-violet">
                      <Key size={16} style={{ color: "#7c5cfc" }} />
                    </span>
                    <div>
                      <p className="font-mono text-sm font-medium text-text-primary">
                        {keyInfo.prefix}
                      </p>
                      <p className="mt-0.5 text-xs font-light text-text-tertiary">
                        Created{" "}
                        {new Date(
                          keyInfo.createdAt * 1000,
                        ).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => setConfirmAction("regenerate")}
                      className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                    >
                      <RefreshCw size={12} />
                      Regenerate
                    </button>
                    <button
                      onClick={() => setConfirmAction("revoke")}
                      className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                    >
                      <Trash2 size={12} />
                      Revoke
                    </button>
                  </div>
                </div>
              </div>
            )}

            {!keyInfo && !newKey && (
              <div className="rounded-[8px] bg-card p-8 text-center ring-1 ring-border">
                <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet/10 text-violet">
                  <Key size={20} style={{ color: "#7c5cfc" }} />
                </span>
                <p className="mb-1 text-sm font-medium text-text-primary">
                  No API key yet
                </p>
                <p className="mb-4 text-xs font-light text-text-tertiary">
                  Generate a key to start using the API programmatically.
                </p>
                <button
                  onClick={handleGenerate}
                  className="inline-flex items-center gap-1.5 rounded-[8px] bg-text-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-text-primary/90"
                >
                  Generate API Key
                </button>
              </div>
            )}

            {/* Usage */}
            <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
              <h2 className="mb-2 text-sm font-semibold text-text-primary">
                Usage
              </h2>
              <p className="mb-3 text-xs font-light text-text-secondary">
                Include your API key in the{" "}
                <code className="rounded bg-bg-muted px-1 py-0.5 font-mono">
                  Authorization
                </code>{" "}
                header.
              </p>
              <pre className="overflow-x-auto rounded-[6px] bg-bg-subtle p-3 text-[12px] font-mono text-text-secondary ring-1 ring-border">
                {`curl -H "Authorization: Bearer sk_..." \\
  ${typeof window !== "undefined" ? window.location.origin : "https://your-instance"}/api/people`}
              </pre>
              <p className="mt-3 text-xs font-light text-text-secondary">
                The key grants full access to the API as your user account. See{" "}
                <a
                  href="/swagger-ui"
                  className="font-medium text-violet hover:underline"
                  style={{ color: "#7c5cfc" }}
                >
                  API docs
                </a>{" "}
                for available endpoints.
              </p>
            </div>

            {isAdmin && <WebhookSection />}
          </>
        )}
      </div>

      {/* Confirmation dialog */}
      <Dialog
        open={confirmAction !== null}
        onOpenChange={() => setConfirmAction(null)}
      >
        <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              {confirmAction === "regenerate"
                ? "Regenerate API Key?"
                : "Revoke API Key?"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm font-light text-text-secondary">
            {confirmAction === "regenerate"
              ? "This will invalidate your current key and generate a new one. Any integrations using the old key will stop working."
              : "This will permanently delete your API key. Any integrations using it will stop working."}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setConfirmAction(null)}
              className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              onClick={
                confirmAction === "regenerate" ? handleGenerate : handleRevoke
              }
              className={`rounded-[6px] px-3 py-1.5 text-xs font-medium text-white ${
                confirmAction === "revoke"
                  ? "bg-destructive hover:bg-destructive/90"
                  : "bg-text-primary hover:bg-text-primary/90"
              }`}
            >
              {confirmAction === "regenerate" ? "Regenerate" : "Revoke"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

function WebhookSection() {
  const [url, setUrl] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [secret, setSecret] = useState(""); // blank = unchanged on save
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    fetchWebhookConfig()
      .then((cfg) => {
        setUrl(cfg.url);
        setHasSecret(cfg.hasSecret);
      })
      .catch(() => {});
  }, []);

  async function onSave() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    setTestResult(null);
    try {
      // Omit `secret` when the field is left blank so we don't clobber an
      // existing secret; send it only when the admin typed something.
      const body: { url: string; secret?: string } = { url: url.trim() };
      if (secret.length > 0) body.secret = secret;
      const cfg = await saveWebhookConfig(body);
      setUrl(cfg.url);
      setHasSecret(cfg.hasSecret);
      setSecret("");
      setSuccess(cfg.url ? "Webhook saved." : "Webhook disabled.");
    } catch {
      setError("Failed to save webhook.");
    } finally {
      setBusy(false);
    }
  }

  async function onClearSecret() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const cfg = await saveWebhookConfig({ url: url.trim(), secret: null });
      setHasSecret(cfg.hasSecret);
      setSecret("");
      setSuccess("Signing secret cleared.");
    } catch {
      setError("Failed to clear secret.");
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    setBusy(true);
    setTestResult(null);
    try {
      const res = await testWebhook();
      setTestResult(
        res.ok
          ? `Test delivered (HTTP ${res.status}).`
          : `Test failed: ${res.error ?? `HTTP ${res.status}`}.`,
      );
    } catch {
      setTestResult("Test failed: request error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-text-primary">Webhook</h2>
      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <p className="text-xs font-light text-text-secondary">
          Fire an HTTP <code>POST</code> to an external automation (n8n, Make,
          etc.) whenever a new inbound message is received. Global, single
          best-effort attempt, disabled by default. When a signing secret is set,
          requests carry an{" "}
          <code>X-SaaSMail-Signature: sha256=&lt;hmac&gt;</code> header over the
          raw body.
        </p>

        <div className="mt-4 space-y-2">
          <label
            htmlFor="webhook-url"
            className="text-xs font-medium uppercase tracking-wider text-text-tertiary"
          >
            Destination URL
          </label>
          <input
            id="webhook-url"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-automation/webhook"
            disabled={busy}
            className="h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30"
          />
        </div>

        <div className="mt-4 space-y-2">
          <label
            htmlFor="webhook-secret"
            className="text-xs font-medium uppercase tracking-wider text-text-tertiary"
          >
            Signing secret (optional)
          </label>
          <input
            id="webhook-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={
              hasSecret ? "•••••••• (set — leave blank to keep)" : "none"
            }
            disabled={busy}
            className="h-10 w-full max-w-sm rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30"
          />
          {hasSecret && (
            <button
              type="button"
              onClick={onClearSecret}
              disabled={busy}
              className="text-xs font-light text-text-secondary hover:text-text-primary hover:underline disabled:opacity-60"
            >
              Clear secret
            </button>
          )}
        </div>

        {error && (
          <p className="mt-3 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
        {success && <p className="mt-3 text-xs text-emerald-600">{success}</p>}
        {testResult && (
          <p className="mt-3 text-xs text-text-secondary">{testResult}</p>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={onTest}
            disabled={busy || !url.trim()}
            className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Send test
          </button>
        </div>
      </div>
    </section>
  );
}
