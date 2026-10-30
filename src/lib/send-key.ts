/**
 * Idempotency keys of the web composers. A compose window sends the same key
 * on every attempt of one message, so a retry after a timeout never sends it
 * twice. The key is forgotten when the message is sent or the window is
 * closed, so the next message gets a new one. It is kept in sessionStorage
 * per compose context ("send:compose", "send:reply:<id>"), so reloading the
 * tab in the middle of a retry (which closes nothing) reuses it.
 *
 * With Undo Send the request can go out after the composer has closed. A
 * send in progress (held for Undo or in flight) owns its key: `beginSend`
 * claims it, `finishSend` releases it, and closing the composer meanwhile
 * does not forget it. When two overlapping sends from one window both fail
 * and are put back together, no one key covers the merged message: the key
 * is dropped and the user is told to check Sent first.
 */
const PREFIX = "saasmail:send-key:";
// When sessionStorage is unavailable (private mode, blocked storage).
const memory = new Map<string, string>();
// Keys owned by a send that has not finished yet.
const held = new Set<string>();
// Contexts where a second failed send met another failed message's key.
const merged = new Set<string>();

function storedKey(context: string): string | null {
  try {
    const stored = sessionStorage.getItem(PREFIX + context);
    if (stored) return stored;
  } catch {
    // Fall back to memory.
  }
  return memory.get(context) ?? null;
}

function storeKey(context: string, key: string): void {
  memory.set(context, key);
  try {
    sessionStorage.setItem(PREFIX + context, key);
  } catch {
    // Memory still has it.
  }
}

function dropKey(context: string): void {
  memory.delete(context);
  try {
    sessionStorage.removeItem(PREFIX + context);
  } catch {
    // Nothing stored.
  }
}

export function sendKeyFor(context: string): string {
  const key = storedKey(context) ?? crypto.randomUUID();
  storeKey(context, key);
  return key;
}

/**
 * Forget the context's key so the next message gets a new one. A key a send
 * in progress still owns is kept: that send forgets it when it finishes.
 */
export function forgetSendKey(context: string): void {
  const key = storedKey(context);
  if (key && held.has(key)) return;
  dropKey(context);
}

/**
 * Pressing Send: claim the key for this message. A message put back after a
 * failed send gets its key again; a context whose key another send still
 * owns (a quick reply sent while the last one waits out its undo window)
 * gets a new one.
 */
export function beginSend(context: string): string {
  let key = storedKey(context);
  if (!key || held.has(key)) key = crypto.randomUUID();
  storeKey(context, key);
  held.add(key);
  return key;
}

/**
 * The send that `beginSend` started is over. Sent or undone: its key is
 * forgotten (undo happens before any request, so the next Send is a new
 * message). Failed: the message goes back to the composer with the same
 * key, so sending it again cannot send it twice.
 */
export function finishSend(
  context: string,
  key: string,
  outcome: "sent" | "undone" | "failed",
): void {
  held.delete(key);
  if (outcome === "failed") {
    const other = storedKey(context);
    if (other && other !== key && !held.has(other)) {
      // Another message from this window failed too, and the two go back
      // together: neither key covers that, so sendKeyProblem warns instead.
      merged.add(context);
      dropKey(context);
      return;
    }
    storeKey(context, key);
  } else if (storedKey(context) === key) dropKey(context);
}

/**
 * What to tell the user when a send was refused because of its key, or null
 * for any other failure. A key already used for a different message means an
 * earlier attempt from this window may have gone out without the window
 * learning it: this message was not sent, the key is replaced so that
 * sending again sends it as it is now, and the user is told to check Sent
 * first.
 */
export function sendKeyProblem(error: unknown, context: string): string | null {
  // An ApiError carries the server's code; read it by shape, so this works
  // wherever the API module is replaced (tests).
  if (merged.delete(context)) {
    return "Two messages from this window failed and were put back together; one of them may already have gone out. Check Sent before sending again.";
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "IDEMPOTENCY_KEY_REUSED") {
    forgetSendKey(context);
    return "This message was not sent: an earlier attempt from this window may already have gone out. Check Sent, then send again to send this one.";
  }
  if (code === "IDEMPOTENCY_IN_PROGRESS") {
    return "The previous attempt is still sending. Try again in a moment.";
  }
  return null;
}
