import { useEffect, useState } from "react";
import { fetchAdminSettings, updateAdminSettings } from "@/lib/api";

/** Settings (admins): check inbound mail for prompt injection. */
export default function InjectionGuardSettings() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAdminSettings()
      .then((settings) => setOn(settings.injectionGuard))
      .catch(() => setError("Could not load this setting."));
  }, []);

  async function save(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const settings = await updateAdminSettings({ injectionGuard: next });
      setOn(settings.injectionGuard);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this setting.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 max-w-3xl rounded-[8px] bg-card p-5 ring-1 ring-border">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={on === true}
          disabled={on === null || busy}
          onChange={(event) => void save(event.target.checked)}
          aria-describedby="injection-guard-hint"
        />
        <span className="text-sm font-medium text-text-primary">
          Check inbound mail for prompt injection before AI filing and the agent
          read it.
        </span>
      </label>
      <p
        id="injection-guard-hint"
        className="mt-1 pl-7 text-xs font-light text-text-secondary"
      >
        A small model checks each received message once, the first time AI
        filing or the agent needs it. A flagged message is not filed, and the
        agent is told not to act on it. Suggested replies always check.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
