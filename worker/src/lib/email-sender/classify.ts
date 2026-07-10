/**
 * Transient-vs-permanent classification for provider send failures
 * (issue #151). Transient = worth retrying via the outbox (quota, rate
 * limits, 5xx, network blips). Permanent = terminal reject (bad recipient,
 * auth) — never retried.
 */

const TRANSIENT_RE =
  /quota|rate.?limit|too many|limit exceeded|timeout|timed out|network|temporar|try again/i;

const PERMANENT_RE =
  /invalid|malformed|validation|unauthorized|forbidden|authentication|not allowed|rejected|55\d/i;

/** Classify by HTTP status when one is available. */
export function transientFromStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Classify a bare error message (thrown exceptions, providers that don't
 * expose an HTTP status). Transient keywords win over permanent ones
 * ("550 over quota" is a quota problem), and unknown messages default to
 * transient — a wasted retry is cheaper than a silently dropped email.
 */
export function classifyErrorMessage(message: string): boolean {
  if (TRANSIENT_RE.test(message)) return true;
  if (PERMANENT_RE.test(message)) return false;
  return true;
}
