import type { ParsedEmail } from "../email-parser";

export type InboxMapping = {
  email: string;
  /** Null means this mapping is the account's own mailbox — the catch-all. */
  gmailGroupAddress: string | null;
};

/**
 * Only these headers decide routing. Deliberately NOT the subject or body:
 * a group address mentioned in prose must never redirect a message.
 */
const ROUTING_HEADERS = [
  "delivered-to",
  "list-id",
  "x-original-to",
  "to",
  "cc",
];

/**
 * Normalise a token: lowercase, map `@<>` to `.`, then strip leading/trailing dots.
 * This handles Google Group List-IDs like `<support.acme.dev>` which become
 * `..support.acme.dev.` after punctuation mapping, then `support.acme.dev` after stripping.
 */
function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[@<>]/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

export function resolveInbox(
  parsed: ParsedEmail,
  mappings: InboxMapping[],
): string | null {
  // Collect all candidate tokens from routing headers, split on whitespace/comma/semicolon/quote
  const headerText = ROUTING_HEADERS.map((h) => parsed.headers?.[h] ?? "")
    .filter(Boolean)
    .join(" ");

  const tokens = headerText
    .split(/[\s,;"]+/)
    .filter(Boolean)
    .map(normalizeToken)
    .filter(Boolean); // Remove empty strings after stripping

  // Check for group matches (highest priority)
  for (const mapping of mappings) {
    if (!mapping.gmailGroupAddress) continue;
    const normalizedAddress = normalizeToken(mapping.gmailGroupAddress.trim());
    if (tokens.includes(normalizedAddress)) {
      return mapping.email.trim().toLowerCase();
    }
  }

  // Fall back to catch-all
  const catchAll = mappings.find((m) => !m.gmailGroupAddress);
  return catchAll ? catchAll.email.trim().toLowerCase() : null;
}
