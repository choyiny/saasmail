export interface SuggestedReplyReadyEvent {
  inbox: string;
  emailId: string;
}

const EVENT_NAME = "saasmail:suggested-reply-ready";

export function dispatchSuggestedReplyReady(
  detail: SuggestedReplyReadyEvent,
): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
}

export function onSuggestedReplyReady(
  listener: (detail: SuggestedReplyReadyEvent) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<SuggestedReplyReadyEvent>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
