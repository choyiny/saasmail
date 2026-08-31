/**
 * Fired to ask the inbox people-list to refetch immediately — e.g. after a
 * WebMCP action saves a reply draft or a sequence enrollment completes, so the
 * new row shows up in the Drafts / Sequenced view without waiting for a manual
 * refresh (navigating to an already-active filter otherwise wouldn't refetch).
 *
 * Same zero-dependency custom-event pattern as lib/email-events.ts.
 */

export const INBOX_REFRESH_EVENT = "saasmail:inbox-refresh";

export function dispatchInboxRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(INBOX_REFRESH_EVENT));
}

export function onInboxRefresh(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(INBOX_REFRESH_EVENT, listener);
  return () => window.removeEventListener(INBOX_REFRESH_EVENT, listener);
}
