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
 * A Google Group's List-ID is usually the address with dots for the @ and
 * wrapped in angle brackets — `<support.acme.dev>`. Normalising both sides to
 * a dotted, punctuation-free form lets one comparison cover every header.
 */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[@<>]/g, ".");
}

export function resolveInbox(
  parsed: ParsedEmail,
  mappings: InboxMapping[],
): string | null {
  const haystack = ROUTING_HEADERS.map((h) => parsed.headers?.[h] ?? "")
    .filter(Boolean)
    .map(normalize)
    .join(" ");

  for (const mapping of mappings) {
    if (!mapping.gmailGroupAddress) continue;
    if (haystack.includes(normalize(mapping.gmailGroupAddress.trim()))) {
      return mapping.email.trim().toLowerCase();
    }
  }

  const catchAll = mappings.find((m) => !m.gmailGroupAddress);
  return catchAll ? catchAll.email.trim().toLowerCase() : null;
}
