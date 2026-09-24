export const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

export const MAX_SIZE_REQUEST = 10_000_000;
export const MAX_CALLS_IN_REQUEST = 16;
export const MAX_OBJECTS_IN_GET = 256;

export const SUPPORTED_CAPABILITIES = new Set([
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
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
