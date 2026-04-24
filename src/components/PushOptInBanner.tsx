import { useState } from "react";
import { enablePush, markPromptDismissed } from "@/lib/push";

export function PushOptInBanner({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnable() {
    setBusy(true);
    setError(null);
    const result = await enablePush();
    setBusy(false);
    if (result.ok) {
      markPromptDismissed();
      onClose();
    } else {
      setError(result.reason);
    }
  }

  function handleDismiss() {
    markPromptDismissed();
    onClose();
  }

  return (
    <div className="mx-4 mt-3 flex items-center justify-between rounded-md border border-border bg-bg-subtle px-4 py-3 text-sm shadow-sm">
      <div>
        <p className="font-medium text-text-primary">
          Get notified even when this tab is closed
        </p>
        {error ? (
          <p className="mt-1 text-xs text-red-600">
            Couldn&apos;t enable notifications: {error}
          </p>
        ) : (
          <p className="mt-1 text-xs text-text-secondary">
            saasmail can send browser push notifications when a new email
            arrives.
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <button
          className="rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          disabled={busy}
          onClick={handleEnable}
        >
          {busy ? "…" : "Enable"}
        </button>
        <button
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-primary"
          onClick={handleDismiss}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
