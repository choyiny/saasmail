import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Copy, Check, Key, PauseCircle, RefreshCw, Trash2 } from "lucide-react";
import {
  fetchApiKeyInfo,
  generateApiKey,
  revokeApiKey,
  enableWebhook,
  fetchWebhookConfig,
  fetchWebhookDeliveries,
  saveWebhookConfig,
  testWebhook,
  WEBHOOK_EVENTS,
} from "@/lib/api";
import type {
  ApiKeyInfo,
  WebhookConfigInfo,
  WebhookDeliveryInfo,
  WebhookEvent,
} from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
          <div className="pt-card space-y-3 p-5" aria-busy="true">
            <span className="pt-skel block h-4 w-1/3" />
            <span className="pt-skel block h-3 w-1/2" />
          </div>
        ) : (
          <>
            {/* Newly generated key — must copy now */}
            {newKey && (
              <div className="rounded-2xl border border-warning-border bg-warning-bg p-4">
                <p className="mb-2.5 text-[13px] font-medium text-warning-text">
                  Copy your API key now. It won't be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    data-testid="api-key-revealed"
                    value={newKey}
                    className="font-code flex-1 text-xs"
                  />
                  <Button variant="outline" onClick={handleCopy}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setNewKey(null)}
                  className="-ml-2 mt-2"
                >
                  Done
                </Button>
              </div>
            )}

            {/* Existing key */}
            {keyInfo && !newKey && (
              <div className="pt-card" data-testid="api-key-row">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4 sm:px-5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-muted">
                    <Key size={16} className="text-text-secondary" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[13.5px] font-medium text-text-primary">
                      {keyInfo.prefix}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-text-tertiary">
                      <span className="pt-sdot ok" aria-hidden />
                      Active · created{" "}
                      {new Date(keyInfo.createdAt * 1000).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmAction("regenerate")}
                    >
                      <RefreshCw />
                      Regenerate
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmAction("revoke")}
                      className="text-destructive hover:bg-destructive-subtle"
                    >
                      <Trash2 />
                      Revoke
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {!keyInfo && !newKey && (
              <div className="pt-card pt-empty">
                <span className="ic">
                  <Key size={18} />
                </span>
                <p>Generate a key to use the API from your own code.</p>
                <Button onClick={handleGenerate}>Generate API Key</Button>
              </div>
            )}

            {/* Usage */}
            <section className="pt-card overflow-hidden">
              <div className="pt-card-head">
                <div>
                  <h2>Usage</h2>
                  <p>
                    Send the key in the{" "}
                    <code className="font-code">Authorization</code> header.
                  </p>
                </div>
              </div>
              <div className="p-5">
                <pre className="font-code overflow-x-auto rounded-lg border border-border bg-bg-subtle p-3 text-xs leading-relaxed text-text-primary">
                  {`curl -H "Authorization: Bearer sk_..." \\
  ${typeof window !== "undefined" ? window.location.origin : "https://your-instance"}/api/people`}
                </pre>
                <p className="mt-3 text-[13px] text-text-secondary">
                  The key acts as your user account. See the{" "}
                  <a
                    href="/swagger-ui"
                    className="font-medium text-accent-subtle-fg underline-offset-2 hover:underline"
                  >
                    API docs
                  </a>{" "}
                  for available endpoints.
                </p>
              </div>
            </section>

            {isAdmin && <WebhookSection />}
          </>
        )}
      </div>

      {/* Confirmation dialog */}
      <Dialog
        open={confirmAction !== null}
        onOpenChange={() => setConfirmAction(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction === "regenerate"
                ? "Regenerate API Key?"
                : "Revoke API Key?"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            {confirmAction === "regenerate"
              ? "This will invalidate your current key and generate a new one. Any integrations using the old key will stop working."
              : "This will permanently delete your API key. Any integrations using it will stop working."}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmAction(null)}>
              Cancel
            </Button>
            <Button
              variant={confirmAction === "revoke" ? "destructive" : "default"}
              onClick={
                confirmAction === "regenerate" ? handleGenerate : handleRevoke
              }
            >
              {confirmAction === "regenerate" ? "Regenerate" : "Revoke"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

// A self-contained prompt the user can paste into any AI assistant to get
// signature-verification code in their own stack — keeps setup instructions
// in-app without shipping per-language code samples or a docs site.
const VERIFY_PROMPT = `Write code for my webhook endpoint to verify incoming SaaSMail webhooks.

Each request includes a header:
  X-SaaSMail-Signature: sha256=<hex>
where <hex> is the HMAC-SHA256 of the EXACT raw request body (the raw bytes, before any JSON parsing), keyed with my webhook signing secret.

The code should:
1. Read the raw request body.
2. Compute HMAC-SHA256(rawBody, secret) and hex-encode it.
3. Compare "sha256=" + that hex to the header value using a constant-time comparison.
4. Reject the request (401) if they don't match.

Events about sent mail (message.sent, message.bounced, message.complained, message.failed) are retried and can arrive more than once: they also carry an X-SaaSMail-Delivery header, the same on every retry. Store it and ignore a request whose value was already handled.

My stack: <your language/framework, e.g. Node/Express, Python/FastAPI, Cloudflare Workers>`;

const EVENT_LABELS: Record<WebhookEvent, string> = {
  "message.received": "A new inbound message",
  "message.sent": "The provider accepted a message sent from here",
  "message.bounced": "A sent message bounced",
  "message.complained": "A recipient marked a sent message as spam",
  "message.failed": "A sent message failed for good",
};

function deliveryResult(delivery: WebhookDeliveryInfo): string {
  if (delivery.lastStatus !== null) return `HTTP ${delivery.lastStatus}`;
  return delivery.lastError ?? "—";
}

function WebhookSection() {
  const [url, setUrl] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [events, setEvents] = useState<WebhookEvent[]>(["message.received"]);
  const [paused, setPaused] = useState<{
    at: number;
    reason: string | null;
  } | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryInfo[]>([]);
  const [testEvent, setTestEvent] = useState<WebhookEvent>("message.received");
  const [secret, setSecret] = useState(""); // blank = unchanged on save
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);

  function copyVerifyPrompt() {
    navigator.clipboard.writeText(VERIFY_PROMPT);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 1500);
  }

  function applyConfig(cfg: WebhookConfigInfo) {
    setUrl(cfg.url);
    setHasSecret(cfg.hasSecret);
    setEvents(cfg.events);
    setPaused(
      cfg.disabledAt !== null
        ? { at: cfg.disabledAt, reason: cfg.disabledReason }
        : null,
    );
  }

  function loadDeliveries() {
    fetchWebhookDeliveries(20)
      .then((res) => setDeliveries(res.deliveries))
      .catch(() => {});
  }

  useEffect(() => {
    fetchWebhookConfig()
      .then(applyConfig)
      .catch(() => {});
    loadDeliveries();
  }, []);

  function toggleEvent(event: WebhookEvent, on: boolean) {
    setEvents((current) =>
      WEBHOOK_EVENTS.filter((e) => (e === event ? on : current.includes(e))),
    );
  }

  async function onEnable() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      applyConfig(await enableWebhook());
      setSuccess("Delivery events re-enabled.");
      loadDeliveries();
    } catch {
      setError("Failed to re-enable the delivery events.");
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    setTestResult(null);
    try {
      // Omit `secret` when the field is left blank so we don't clobber an
      // existing secret; send it only when the admin typed something.
      const body: { url: string; secret?: string; events: WebhookEvent[] } = {
        url: url.trim(),
        events,
      };
      if (secret.length > 0) body.secret = secret;
      const cfg = await saveWebhookConfig(body);
      applyConfig(cfg);
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
      const res = await testWebhook(testEvent);
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
    <section className="pt-card overflow-hidden">
      <div className="pt-card-head">
        <div>
          <h2>Webhook</h2>
          <p>
            POST new inbound messages and delivery events to an external
            automation.
          </p>
        </div>
      </div>
      <div className="p-5">
        <p className="text-[13px] text-text-secondary">
          Fire an HTTP <code className="font-code">POST</code> to n8n, Make or
          similar whenever a new inbound message is received. Global, single
          best-effort attempt, disabled by default. Events about sent mail are
          opt-in and retried. With a signing secret set, requests carry an{" "}
          <code className="font-code">
            X-SaaSMail-Signature: sha256=&lt;hmac&gt;
          </code>{" "}
          header over the raw body.
        </p>

        {paused && (
          <div
            role="status"
            data-testid="webhook-paused-banner"
            className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[8px] border border-warning-border bg-warning-bg px-4 py-2.5 text-xs text-warning-text"
          >
            <PauseCircle size={14} aria-hidden className="shrink-0" />
            <span className="min-w-0 flex-1">
              Delivery events paused after 20 failed deliveries
              {paused.reason ? `: ${paused.reason}` : ""}. New inbound messages
              are still sent.
            </span>
            <Button size="sm" onClick={onEnable} disabled={busy}>
              Re-enable
            </Button>
          </div>
        )}

        <div className="mt-5 space-y-1.5">
          <label
            htmlFor="webhook-url"
            className="block text-[13px] font-medium text-text-primary"
          >
            Destination URL
          </label>
          <Input
            id="webhook-url"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-automation/webhook"
            disabled={busy}
            className="font-code"
          />
        </div>

        <fieldset className="mt-4">
          <legend className="text-[13px] font-medium text-text-primary">
            Events
          </legend>
          <div className="mt-1.5 space-y-1.5">
            {WEBHOOK_EVENTS.map((event) => (
              <label
                key={event}
                className="flex items-center gap-2 text-xs text-text-secondary"
              >
                <input
                  type="checkbox"
                  checked={events.includes(event)}
                  disabled={busy}
                  onChange={(e) => toggleEvent(event, e.target.checked)}
                />
                <code className="font-code text-text-primary">{event}</code>
                <span>{EVENT_LABELS[event]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4 space-y-1.5">
          <label
            htmlFor="webhook-secret"
            className="block text-[13px] font-medium text-text-primary"
          >
            Signing secret{" "}
            <span className="font-normal text-text-tertiary">(optional)</span>
          </label>
          <Input
            id="webhook-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={
              hasSecret ? "•••••••• (set — leave blank to keep)" : "none"
            }
            disabled={busy}
            className="max-w-sm"
          />
          {hasSecret && (
            <button
              type="button"
              onClick={onClearSecret}
              disabled={busy}
              className="text-xs text-text-secondary hover:text-text-primary hover:underline disabled:opacity-60"
            >
              Clear secret
            </button>
          )}
        </div>

        {/* In-app verification guidance — no docs site, so hand the user an
            AI prompt that generates verifier code for whatever stack they use. */}
        <div className="mt-5 rounded-xl border border-border bg-bg-subtle p-3.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-text-primary">
              Verifying signatures
            </p>
            <Button variant="outline" size="sm" onClick={copyVerifyPrompt}>
              {promptCopied ? <Check /> : <Copy />}
              {promptCopied ? "Copied" : "Copy prompt"}
            </Button>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Paste this prompt into your AI assistant to generate verification
            code for your stack.
          </p>
          <pre className="font-code mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-card p-2.5 text-[11.5px] leading-relaxed text-text-secondary">
            {VERIFY_PROMPT}
          </pre>
        </div>

        {error && (
          <p className="mt-3 text-[13px] text-destructive" role="alert">
            {error}
          </p>
        )}
        {success && <p className="mt-3 text-[13px] text-success">{success}</p>}
        {testResult && (
          <p className="mt-3 text-[13px] text-text-secondary">{testResult}</p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <label htmlFor="webhook-test-event" className="sr-only">
            Test event
          </label>
          <select
            id="webhook-test-event"
            value={testEvent}
            onChange={(e) => setTestEvent(e.target.value as WebhookEvent)}
            disabled={busy}
            className="font-code h-8 rounded-md border border-border bg-card px-2 text-xs text-text-primary"
          >
            {WEBHOOK_EVENTS.map((event) => (
              <option key={event} value={event}>
                {event}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            onClick={onTest}
            disabled={busy || !url.trim()}
          >
            Send test
          </Button>
        </div>

        <div className="mt-6">
          <p className="text-[13px] font-medium text-text-primary">
            Recent deliveries
          </p>
          {deliveries.length === 0 ? (
            <p className="mt-1 text-xs text-text-tertiary">
              No delivery events yet. Inbound messages are not listed.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table
                className="w-full text-left text-xs"
                data-testid="webhook-deliveries"
              >
                <thead className="text-text-tertiary">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Event</th>
                    <th className="py-1 pr-3 font-medium">Time</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Result</th>
                    <th className="py-1 font-medium">Attempts</th>
                  </tr>
                </thead>
                <tbody className="text-text-secondary">
                  {deliveries.map((delivery) => (
                    <tr key={delivery.id} className="border-t border-border">
                      <td className="font-code py-1 pr-3">{delivery.event}</td>
                      <td className="py-1 pr-3">
                        {new Date(delivery.createdAt * 1000).toLocaleString()}
                      </td>
                      <td className="py-1 pr-3">{delivery.status}</td>
                      <td className="py-1 pr-3">{deliveryResult(delivery)}</td>
                      <td className="py-1">{delivery.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
