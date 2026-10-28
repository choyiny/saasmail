import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
} from "lucide-react";
import {
  fetchIntegrations,
  saveIntegration,
  type ProviderSettings,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type Provider = ProviderSettings["provider"];

const COPY: Record<
  Provider,
  { label: string; steps: string; clientIdHint: string; envVars?: string }
> = {
  google: {
    label: "Google",
    steps:
      "In Google Cloud Console, enable the Gmail API, then create an OAuth client of type “Web application” under APIs & Services → Credentials, with this authorized redirect URI:",
    clientIdHint: "…apps.googleusercontent.com",
    envVars: "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET",
  },
  microsoft: {
    label: "Microsoft",
    steps:
      "In the Microsoft Entra admin center, register an app under App registrations (accounts in any organizational directory and personal Microsoft accounts), add a client secret, and add this Web redirect URI:",
    clientIdHint: "Application (client) ID",
  },
};

/**
 * A provider's OAuth app settings, edited in place: client id, client secret
 * (write-only — the server never sends it back) and, for Microsoft, the
 * tenant. Opens by itself while the provider is not set up, since nothing
 * else on the page works until it is.
 */
export default function ProviderSettingsPanel({
  provider,
  onSaved,
}: {
  provider: Provider;
  onSaved?: (settings: ProviderSettings) => void;
}) {
  const copy = COPY[provider];
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tenant, setTenant] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchIntegrations()
      .then((res) => {
        if (cancelled) return;
        const mine = res.providers.find((p) => p.provider === provider);
        if (!mine) return;
        setSettings(mine);
        setKeyConfigured(res.encryptionKeyConfigured);
        setClientId(mine.clientId ?? "");
        setTenant(mine.tenant ?? "");
        if (!mine.configured) setOpen(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Couldn't load the settings",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  if (loadError) {
    return (
      <p
        className="text-xs text-destructive"
        data-testid={`${provider}-settings-error`}
      >
        Couldn&apos;t load the {copy.label} settings ({loadError}).
      </p>
    );
  }
  if (!settings) return null;

  const clientIdChanged =
    settings.clientId !== null && clientId.trim() !== settings.clientId;
  const needsSecret = !settings.hasClientSecret || settings.source === "env";
  const canSave =
    keyConfigured &&
    clientId.trim().length > 0 &&
    (!needsSecret || clientSecret.length > 0) &&
    !saving;

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const next = await saveIntegration(provider, {
        clientId: clientId.trim(),
        ...(clientSecret ? { clientSecret } : {}),
        ...(provider === "microsoft" ? { tenant: tenant.trim() || null } : {}),
      });
      setSettings(next);
      setClientSecret("");
      setSaved(true);
      onSaved?.(next);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Couldn't save the settings",
      );
    } finally {
      setSaving(false);
    }
  }

  async function copyRedirect() {
    try {
      await navigator.clipboard.writeText(settings!.redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the URI is on screen to select by hand.
    }
  }

  const status = !keyConfigured
    ? { text: "Needs TOKEN_ENCRYPTION_KEY", tone: "warn" as const }
    : settings.configured
      ? settings.source === "env"
        ? { text: "Set up (from env vars)", tone: "ok" as const }
        : { text: "Set up", tone: "ok" as const }
      : { text: "Not set up", tone: "warn" as const };

  const input =
    "h-9 w-full rounded-lg bg-card px-3 text-sm text-text-primary ring-1 ring-border placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50";

  return (
    <div
      className="rounded-lg bg-card ring-1 ring-border"
      data-testid={`${provider}-settings`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium text-text-primary">
          {copy.label} settings
        </span>
        <span
          data-testid={`${provider}-settings-status`}
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
            status.tone === "ok"
              ? "bg-success-subtle text-success"
              : "bg-warning-bg text-warning",
          )}
        >
          {status.text}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3 text-xs">
          {!keyConfigured && (
            <div className="flex gap-2 rounded-lg bg-warning-bg px-3 py-2 text-warning">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                <span className="font-medium">
                  TOKEN_ENCRYPTION_KEY is not set.
                </span>{" "}
                It encrypts the client secret and every mailbox&apos;s refresh
                token, so it stays a wrangler secret. Run{" "}
                <code className="font-mono">
                  wrangler secret put TOKEN_ENCRYPTION_KEY
                </code>{" "}
                with 32 random bytes, base64-encoded (
                <code className="font-mono">openssl rand -base64 32</code>), and
                redeploy.
              </span>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-text-secondary">{copy.steps}</p>
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded-lg bg-bg-muted px-2 py-1.5 font-mono text-text-primary"
                data-testid={`${provider}-redirect-uri`}
              >
                {settings.redirectUri}
              </code>
              <button
                type="button"
                onClick={copyRedirect}
                className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-text-secondary ring-1 ring-border hover:bg-bg-muted"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          {settings.source === "env" && copy.envVars && (
            <p className="text-text-tertiary">
              These are currently read from{" "}
              <code className="font-mono">{copy.envVars}</code>. Saving here
              takes over from them; you can then remove the vars.
            </p>
          )}

          <label className="block">
            <span className="mb-1 block font-medium text-text-secondary">
              Client ID
            </span>
            <input
              className={input}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={copy.clientIdHint}
              disabled={!keyConfigured}
              autoComplete="off"
              spellCheck={false}
              data-testid={`${provider}-client-id`}
            />
          </label>

          <label className="block">
            <span className="mb-1 block font-medium text-text-secondary">
              Client secret
            </span>
            <input
              className={input}
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={
                needsSecret
                  ? ""
                  : "Stored — leave blank to keep the current secret"
              }
              disabled={!keyConfigured}
              autoComplete="new-password"
              data-testid={`${provider}-client-secret`}
            />
          </label>

          {provider === "microsoft" && (
            <label className="block">
              <span className="mb-1 block font-medium text-text-secondary">
                Tenant (optional)
              </span>
              <input
                className={input}
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                placeholder="Blank for any work, school or personal account"
                disabled={!keyConfigured}
                autoComplete="off"
                spellCheck={false}
                data-testid={`${provider}-tenant`}
              />
              <span className="mt-1 block text-text-tertiary">
                A directory ID or domain (contoso.onmicrosoft.com) limits
                sign-in to that organization.
              </span>
            </label>
          )}

          {clientIdChanged && settings.connectedMailboxes > 0 && (
            <div
              className="flex gap-2 rounded-lg bg-warning-bg px-3 py-2 text-warning"
              data-testid={`${provider}-client-change-warning`}
            >
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                {settings.connectedMailboxes === 1
                  ? "1 mailbox was"
                  : `${settings.connectedMailboxes} mailboxes were`}{" "}
                connected through the current client ID. Its access belongs to
                that app, so after this change each one stops syncing until it
                is reconnected.
              </span>
            </div>
          )}

          {saveError && (
            <p
              className="text-destructive"
              data-testid={`${provider}-save-error`}
            >
              {saveError}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              data-testid={`${provider}-settings-save`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
            >
              {saving && <Loader2 size={12} className="animate-spin" />}
              Save
            </button>
            {saved && <span className="text-success">Saved.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
