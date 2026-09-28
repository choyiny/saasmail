export const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";

export const MAX_SIZE_REQUEST = 10_000_000;
export const MAX_CALLS_IN_REQUEST = 16;
export const MAX_OBJECTS_IN_GET = 256;
export const MAX_OBJECTS_IN_SET = 256;

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
