import { useEffect, useState } from "react";
import {
  isPushSupported,
  isPushSubscribed,
  enablePush,
  disablePush,
} from "@/lib/push";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import {
  HIDE_SIGNATURES_EVENT,
  HIDE_SIGNATURES_STORAGE_KEY,
  readHideSignatures,
  writeHideSignatures,
} from "@/lib/signatures";
import { useSession } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";
import {
  readDefaultView,
  writeDefaultView,
  type DefaultView,
} from "@/lib/default-view";

interface Subscription {
  id: string;
  userAgent: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";

  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        subtitle="Manage notifications, display preferences, and (admin only) app branding."
      />

      <div className="max-w-3xl space-y-8">
        <NotificationsSection />
        <DisplayPreferencesSection />
        {isAdmin && <AppBrandingSection />}
      </div>
    </PageContainer>
  );
}

/* --------------------------------- 1. Notifications -------------------------------- */

function NotificationsSection() {
  const [supported] = useState(isPushSupported);
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);
  const [subscribedHere, setSubscribedHere] = useState(false);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [busy, setBusy] = useState(false);
  const [vapidPublicKey, setVapidPublicKey] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const cfg = await fetch("/api/notifications/config", {
      credentials: "include",
    }).then((r) => r.json());
    setPushEnabled(cfg.pushEnabled);
    setVapidPublicKey(cfg.vapidPublicKey);
    setSubscribedHere(await isPushSubscribed());
    const list = await fetch("/api/notifications/subscriptions", {
      credentials: "include",
    }).then((r) => r.json());
    setSubs(list.subscriptions ?? []);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onEnable() {
    setError(null);
    setBusy(true);
    try {
      const result = await enablePush();
      if ("reason" in result) {
        setError(result.reason);
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function onDisable() {
    setBusy(true);
    try {
      await disablePush();
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function onRevoke(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/notifications/subscriptions/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-text-primary">
        Notifications
      </h2>

      {!supported ? (
        <p className="text-sm text-text-secondary">
          Your browser does not support push notifications.
        </p>
      ) : pushEnabled === null ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : pushEnabled === false ? (
        <p className="text-sm text-text-secondary">
          Push notifications are not configured on this saasmail deployment.
        </p>
      ) : (
        <div className="space-y-5">
          <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
            <h3 className="text-sm font-semibold text-text-primary">
              This browser
            </h3>
            <p className="mt-1 text-xs font-light text-text-secondary">
              {subscribedHere
                ? "Push is on for this browser."
                : "Push is off for this browser."}
            </p>
            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
            <div className="mt-3">
              {subscribedHere ? (
                <button
                  className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                  disabled={busy || !vapidPublicKey}
                  onClick={onDisable}
                >
                  Disable
                </button>
              ) : (
                <button
                  className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-text-primary/90"
                  disabled={busy || !vapidPublicKey}
                  onClick={onEnable}
                >
                  Enable
                </button>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <div className="border-b border-border px-5 py-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                All subscribed browsers
              </h3>
            </div>
            {subs.length === 0 ? (
              <p className="px-5 py-4 text-xs font-light text-text-tertiary">
                None yet.
              </p>
            ) : (
              <ul className="divide-y divide-border/60 text-xs">
                {subs.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-4 px-5 py-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-text-primary">
                        {s.userAgent ?? "Unknown browser"}
                      </div>
                      <div className="text-xs font-light text-text-tertiary">
                        added {new Date(s.createdAt * 1000).toLocaleString()}
                        {s.lastUsedAt
                          ? ` · last used ${new Date(s.lastUsedAt * 1000).toLocaleString()}`
                          : ""}
                      </div>
                    </div>
                    <button
                      className="rounded-[6px] border border-border px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                      disabled={busy}
                      onClick={() => onRevoke(s.id)}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------ 2. Display preferences ----------------------------- */

function DisplayPreferencesSection() {
  const [hideSignatures, setHideSignatures] = useState(() =>
    readHideSignatures(),
  );
  const [defaultView, setDefaultView] = useState<DefaultView>(() =>
    readDefaultView(),
  );

  // Stay in sync with other tabs (cross-tab) AND with the in-tab event the
  // signatures lib dispatches.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === HIDE_SIGNATURES_STORAGE_KEY) {
        setHideSignatures(readHideSignatures());
      }
    }
    function onCustom() {
      setHideSignatures(readHideSignatures());
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(HIDE_SIGNATURES_EVENT, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(HIDE_SIGNATURES_EVENT, onCustom);
    };
  }, []);

  function toggle() {
    const next = !hideSignatures;
    setHideSignatures(next);
    writeHideSignatures(next);
  }

  function changeDefaultView(value: DefaultView) {
    setDefaultView(value);
    writeDefaultView(value);
  }

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-text-primary">
        Display preferences
      </h2>

      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-text-primary">
              Default home view
            </h3>
            <p className="mt-1 text-xs font-light text-text-secondary">
              Choose what opens when you visit the app root. Deep links are
              never redirected.
            </p>
          </div>
          <select
            aria-label="Default home view"
            data-testid="default-view-select"
            value={defaultView}
            onChange={(event) =>
              changeDefaultView(event.target.value as DefaultView)
            }
            className="h-9 shrink-0 rounded-[6px] border border-border bg-bg-subtle px-2 text-xs text-text-primary"
          >
            <option value="customers">Customers</option>
            <option value="mailbox">Mailbox</option>
          </select>
        </div>
      </div>

      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-text-primary">
              Hide signatures in chat
            </h3>
            <p className="mt-1 text-xs font-light text-text-secondary">
              Strip the signature block from chat-mode bubbles to keep the feed
              clean.
            </p>
          </div>
          <button
            type="button"
            onClick={toggle}
            aria-checked={hideSignatures}
            role="switch"
            data-testid="hide-signatures-toggle"
            className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
              hideSignatures ? "bg-text-primary" : "bg-bg-muted"
            }`}
          >
            <span
              className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${
                hideSignatures ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------- 3. App branding -------------------------------- */

function AppBrandingSection() {
  const { brandName, refresh: refreshBranding } = useBranding();
  const [value, setValue] = useState(brandName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Keep input in sync if the upstream brand name changes (e.g. another
  // admin updates it; we re-fetched and BrandingProvider notified).
  useEffect(() => {
    setValue(brandName);
  }, [brandName]);

  async function patch(body: { brandName: string | null }) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(data.error || "Failed to update brand name.");
        return;
      }
      const data = (await res.json()) as { brandName: string };
      setSuccess(`Saved. The wordmark now reads "${data.brandName}".`);
      // Push the new value into the live BrandingProvider so the top-nav
      // wordmark updates without a page reload.
      await refreshBranding();
    } catch {
      setError("Failed to update brand name.");
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("App name can't be empty.");
      return;
    }
    if (trimmed.length > 40) {
      setError("App name must be 40 characters or fewer.");
      return;
    }
    await patch({ brandName: trimmed });
  }

  async function onReset() {
    await patch({ brandName: null });
  }

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-text-primary">
        App branding
      </h2>

      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <p className="text-xs font-light text-text-secondary">
          The app name appears in the top-nav wordmark, the login screen, and
          invitation emails. Defaults to <code>saasmail</code>.
        </p>
        <div className="mt-4 space-y-2">
          <label
            htmlFor="branding-app-name"
            className="text-xs font-medium uppercase tracking-wider text-text-tertiary"
          >
            App name
          </label>
          <input
            id="branding-app-name"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={40}
            disabled={busy}
            className="h-10 w-full max-w-sm rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30"
          />
        </div>

        {error && (
          <p className="mt-3 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
        {success && (
          <p
            className="mt-3 text-xs text-emerald-600"
            data-testid="branding-success"
          >
            {success}
          </p>
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
            onClick={onReset}
            disabled={busy}
            className="text-xs font-light text-text-secondary hover:text-text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            Reset to default
          </button>
        </div>
      </div>
    </section>
  );
}
