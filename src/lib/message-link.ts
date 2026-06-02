import { showToast } from "@/lib/toast";

/** Stable DOM id used to scroll/flash a deep-linked message. */
export function messageDomId(emailId: string): string {
  return `m-${emailId}`;
}

/** Public, shareable URL that resolves to a specific message in context. */
export function buildMessageUrl(emailId: string): string {
  return `${window.location.origin}/m/${encodeURIComponent(emailId)}`;
}

/**
 * Reads a deep-linked message id from the URL hash. The router lands a deep
 * link as `…/inbox/<inbox>/<personId>#m=<emailId>`; consumers (PersonDetail)
 * use this to scroll the target into view after emails finish loading.
 */
export function readMessageHash(hash: string): string | null {
  const m = hash.match(/^#m=(.+)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export async function copyMessageLink(emailId: string): Promise<void> {
  const url = buildMessageUrl(emailId);
  try {
    await navigator.clipboard.writeText(url);
    showToast({ kind: "success", message: "Message link copied" });
  } catch {
    showToast({
      kind: "error",
      message: "Couldn't copy link",
      description: url,
      durationMs: 8000,
    });
  }
}
