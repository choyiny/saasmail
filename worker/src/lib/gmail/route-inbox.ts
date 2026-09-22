/**
 * Resolve a Gmail message to the personal mailbox it belongs to.
 *
 * This module deliberately does NOT scan headers. Header-based routing was
 * removed after three rounds of security review found that both List-ID and
 * Delivered-To are sender-forgeable: List-ID has no authentication; Delivered-To
 * is forgeable via duplicate-header collapse in the email parser (the real one
 * is prepended by Gmail, an attacker's sits below, parser takes last-wins).
 *
 * Personal mailboxes are 1:1 — exactly one saasmail inbox per Gmail account.
 * Group routing (many Groups → many inboxes from one mailbox) is deferred to a
 * later slice with a design that keys on something a sender cannot set.
 *
 * For now, resolve to the account's own mailbox (gmailGroupAddress === null).
 * Ignore all group mappings. This removes the attack surface instead of trying
 * to parse around it.
 */

export type InboxMapping = {
  email: string;
  /** Null means this mapping is the account's own mailbox — the catch-all. */
  gmailGroupAddress: string | null;
};

/**
 * Resolve a Gmail message to the saasmail inbox for a personal mailbox.
 *
 * For a personal account, there is exactly one mapping with gmailGroupAddress === null.
 * Group mappings (gmailGroupAddress !== null) are ignored entirely.
 *
 * @param mappings - InboxMappings, each with email and gmailGroupAddress
 * @returns The email address of the account's own mailbox (lowercase, trimmed),
 *          or null if no personal mailbox mapping exists or if the configuration
 *          is ambiguous (multiple null mappings).
 */
export function resolvePersonalInbox(mappings: InboxMapping[]): string | null {
  // Find all mappings where gmailGroupAddress is null (personal mailbox)
  const personalMappings = mappings.filter((m) => m.gmailGroupAddress === null);

  // Exactly one personal mailbox expected. More than one is a misconfiguration
  // and we return null rather than picking arbitrarily, because picking based on
  // array order would make which inbox receives customer mail depend on database row order.
  if (personalMappings.length === 0) {
    return null;
  }
  if (personalMappings.length > 1) {
    return null;
  }

  // Return the single personal mailbox address (lowercase and trimmed)
  return personalMappings[0].email.trim().toLowerCase();
}
