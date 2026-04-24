import { useEffect, useState } from "react";
import {
  isPushSupported,
  isPushSubscribed,
  enablePush,
  disablePush,
} from "@/lib/push";

interface Subscription {
  id: string;
  userAgent: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export default function NotificationsSettingsPage() {
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

  if (!supported) {
    return (
      <div className="p-6 text-sm text-text-secondary">
        Your browser does not support push notifications.
      </div>
    );
  }
  if (pushEnabled === null) {
    return <div className="p-6 text-sm text-text-secondary">Loading…</div>;
  }
  if (pushEnabled === false) {
    return (
      <div className="p-6 text-sm text-text-secondary">
        Push notifications are not configured on this saasmail deployment.
      </div>
    );
  }

  async function onEnable() {
    setError(null);
    setBusy(true);
    try {
      const result = await enablePush();
      if (!result.ok) {
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
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-xl font-semibold text-text-primary">Notifications</h1>

      <section className="rounded-md border border-border bg-bg-subtle p-4">
        <h2 className="text-sm font-medium text-text-primary">This browser</h2>
        <p className="mt-1 text-xs text-text-tertiary">
          {subscribedHere
            ? "Push is on for this browser."
            : "Push is off for this browser."}
        </p>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        <div className="mt-3">
          {subscribedHere ? (
            <button
              className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary"
              disabled={busy || !vapidPublicKey}
              onClick={onDisable}
            >
              Disable
            </button>
          ) : (
            <button
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
              disabled={busy || !vapidPublicKey}
              onClick={onEnable}
            >
              Enable
            </button>
          )}
        </div>
      </section>

      <section className="rounded-md border border-border bg-bg-subtle p-4">
        <h2 className="text-sm font-medium text-text-primary">
          All subscribed browsers
        </h2>
        {subs.length === 0 ? (
          <p className="mt-1 text-xs text-text-tertiary">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border text-xs">
            {subs.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2">
                <div>
                  <div className="font-medium text-text-primary">
                    {s.userAgent ?? "Unknown browser"}
                  </div>
                  <div className="text-text-tertiary">
                    added {new Date(s.createdAt * 1000).toLocaleString()}
                    {s.lastUsedAt
                      ? ` · last used ${new Date(s.lastUsedAt * 1000).toLocaleString()}`
                      : ""}
                  </div>
                </div>
                <button
                  className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                  disabled={busy}
                  onClick={() => onRevoke(s.id)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
