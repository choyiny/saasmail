import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * The HTML an operator pastes on their own site.
 *
 * The markup comes from the API, never from here. It contains the honeypot
 * field the public subscribe endpoint actually checks by name — a snippet
 * built client-side would drift from that check and silently disable the
 * honeypot for everyone who copied it.
 */
export default function FormSnippet({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-[8px] bg-card ring-1 ring-border">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
        <p className="text-[11px] uppercase tracking-wide text-text-tertiary">
          Embed snippet
        </p>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(snippet);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-text-secondary">
        <code>{snippet}</code>
      </pre>
    </div>
  );
}
