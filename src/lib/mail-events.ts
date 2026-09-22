/**
 * Fired when message state changes should refresh the conventional mailbox UI.
 *
 * Kept separate from inbox-events because the customer-centric inbox and the
 * mailbox surface have independent data loaders.
 */

export const MAIL_REFRESH_EVENT = "saasmail:mail-refresh";

export function dispatchMailRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MAIL_REFRESH_EVENT));
}

export function onMailRefresh(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(MAIL_REFRESH_EVENT, listener);
  return () => window.removeEventListener(MAIL_REFRESH_EVENT, listener);
}
