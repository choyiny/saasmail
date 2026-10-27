import { useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { enablePush, markPromptDismissed } from "@/lib/push";

export function PushOptInBanner({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnable() {
    setBusy(true);
    setError(null);
    const result = await enablePush();
    setBusy(false);
    if (result.ok === false) {
      setError(result.reason);
    } else {
      markPromptDismissed();
      onClose();
    }
  }

  function handleDismiss() {
    markPromptDismissed();
    onClose();
  }

  return (
    <div className="mx-3 mt-3 flex flex-col gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-sm shadow-card">
      <div className="flex gap-2.5">
        <Bell size={16} className="mt-0.5 shrink-0 text-text-secondary" />
        <div>
          <p className="text-[13.5px] font-medium text-text-primary">
            Get notified even when this tab is closed
          </p>
          {error ? (
            <p className="mt-1 text-xs text-destructive">
              Couldn&apos;t enable notifications: {error}
            </p>
          ) : (
            <p className="mt-1 text-xs text-text-secondary">
              saasmail can send browser push notifications when a new email
              arrives.
            </p>
          )}
        </div>
      </div>
      <div className="flex gap-2 pl-[26px]">
        <Button size="sm" disabled={busy} onClick={handleEnable}>
          {busy ? "…" : "Enable"}
        </Button>
        <Button size="sm" variant="ghost" onClick={handleDismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}
