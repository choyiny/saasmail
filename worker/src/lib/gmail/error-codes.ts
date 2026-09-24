/**
 * The `gmail_accounts.lastError` vocabulary, in one place.
 *
 * Both ends of the wire read it: the sync engine writes these values, and
 * `src/components/ConnectedMailboxes.tsx` decides from them whether Reconnect
 * can help and what to tell the operator instead. The frontend used to
 * re-declare the literals, which let the two drift without anything failing.
 *
 * Like `lib/interpolate.ts`, this module imports nothing and touches no
 * Cloudflare globals, so it bundles for the browser as-is through the
 * `@worker/*` alias.
 */

/**
 * An expired history cursor forced a re-seed from the present. The mailbox
 * still works; mail that arrived in the gap was never synced.
 *
 * TRANSIENT — the next successful run clears it. `gmail_accounts.lastGapAt`
 * is the durable record of the same event.
 */
export const HISTORY_GAP_ERROR = "history_gap";

/** No inbox is mapped to this mailbox's personal mail, so nothing can route. */
export const NO_PERSONAL_INBOX_ERROR = "no_personal_inbox";

/** More than one inbox is mapped to it, and guessing is worse than stalling. */
export const AMBIGUOUS_INBOX_MAPPING_ERROR = "ambiguous_inbox_mapping";

/**
 * One message could not be ingested: `message_failed:<gmail message id>`.
 * The cursor did not move past it, so the next run retries it.
 */
export const MESSAGE_FAILED_PREFIX = "message_failed:";

/**
 * The run could not sync at all: `sync_failed:<code>`, where the code is
 * Gmail's own classification (`http_500`, `rate_limited`, …) or `unknown`.
 *
 * Only `http_401` and `http_403` mean the credential was refused, so those
 * are the only ones a fresh grant can fix — see RECONNECTABLE_SYNC_FAILURES
 * in src/components/ConnectedMailboxes.tsx.
 */
export const SYNC_FAILED_PREFIX = "sync_failed:";
