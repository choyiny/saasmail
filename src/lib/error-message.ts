/**
 * What `apiFetch` throws when a failed response carries no message of its
 * own. Kept here — rather than inline in api.ts — so the one place that
 * recognises this shape and the one place that produces it can't drift.
 */
export function statusFallbackMessage(status: number): string {
  return `API error: ${status}`;
}

const BARE_STATUS = /^API error: \d+$/;

/**
 * The server's own explanation of a failure, or null when the failure
 * carries nothing a person could act on.
 *
 * A bare `API error: 502` is a number, not an explanation, so it reads as
 * "nothing useful" and the caller's own wording wins. Anything else is the
 * server talking — a Gmail reply that was rejected and, crucially, *not
 * queued for retry* says so here, and that sentence is the difference
 * between the user re-sending and waiting forever for a retry that will
 * never happen.
 */
export function serverErrorMessage(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  const message = e.message.trim();
  if (message === "" || BARE_STATUS.test(message)) return null;
  return message;
}
