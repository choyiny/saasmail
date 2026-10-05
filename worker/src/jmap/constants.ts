export const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";

export const MAX_SIZE_REQUEST = 10_000_000;
export const MAX_CALLS_IN_REQUEST = 16;
export const MAX_OBJECTS_IN_GET = 256;
export const MAX_OBJECTS_IN_SET = 256;

/**
 * The largest `Email/query` page (RFC 8620 §5.5 `limit`): a request without a
 * limit, or with a larger one, gets this many and is told so. It is not a cap
 * on the result set: `position` beyond it works and `total` counts everything.
 * `Email/queryChanges` can only diff a result that fits in one such page.
 */
export const MAX_QUERY_RESULTS = 10_000;

/** EventSource push (RFC 8620 §7.3): the path the Session advertises. */
export const EVENT_SOURCE_PATH = "/jmap/eventsource/";
/** How often an open push stream looks for a new state. */
export const PUSH_TICK_SECONDS = 10;
/** A comment line goes out after this long without any bytes written. */
export const PUSH_KEEPALIVE_SECONDS = 30;
/** A stream closes cleanly after this long; clients reconnect. */
export const PUSH_LIFETIME_SECONDS = 5 * 60;
/**
 * A stream closes once it has used this many D1 queries (connect included),
 * well under the 50 a Workers free-plan invocation allows.
 */
export const PUSH_QUERY_BUDGET = 40;
export const PUSH_MIN_PING_SECONDS = 10;
export const PUSH_MAX_PING_SECONDS = 300;

/**
 * The longest delayed send, in seconds (RFC 8621 `maxDelayedSend`, RFC 4865
 * FUTURERELEASE interval): 24 hours, the longest delay a Cloudflare Queues
 * message accepts, so one queue message releases every scheduled send.
 */
export const MAX_DELAYED_SEND = 86_400;

export const SUPPORTED_CAPABILITIES = new Set([
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SUBMISSION_CAPABILITY,
]);

export const SYSTEM_MAILBOX_ROLES = [
  "inbox",
  "drafts",
  "sent",
  "archive",
  "junk",
  "trash",
] as const;

export type SystemMailboxRole = (typeof SYSTEM_MAILBOX_ROLES)[number];
