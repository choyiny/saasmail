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
 * Normalise a candidate address: lowercase, map `@<>` to `.`, then strip leading/trailing dots.
 * This handles Google Group List-IDs like `<support.acme.dev>` which become
 * `..support.acme.dev.` after punctuation mapping, then `support.acme.dev` after stripping.
 */
function normalizeAddress(value: string): string {
  return value
    .toLowerCase()
    .replace(/[@<>]/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

/**
 * Extract a candidate address from an RFC 5322 address chunk.
 * If the chunk contains angle brackets, extract the content of the LAST `<...>` pair
 * (the display name before it is discarded as attacker-controlled).
 * Otherwise, use the whole chunk trimmed.
 */
function extractCandidate(chunk: string): string {
  const trimmed = chunk.trim();

  // Find the LAST occurrence of < and >
  const lastOpenBracket = trimmed.lastIndexOf("<");
  if (lastOpenBracket !== -1) {
    const lastCloseBracket = trimmed.lastIndexOf(">");
    if (lastCloseBracket > lastOpenBracket) {
      // Extract content between the last pair of brackets
      return trimmed.substring(lastOpenBracket + 1, lastCloseBracket);
    }
  }

  // No angle brackets, use the whole chunk
  return trimmed;
}

export function resolveInbox(
  parsed: ParsedEmail,
  mappings: InboxMapping[],
): string | null {
  // Collect candidate addresses from routing headers by splitting on commas
  const candidates: string[] = [];

  for (const header of ROUTING_HEADERS) {
    const headerValue = parsed.headers?.[header];
    if (!headerValue) continue;

    // Split on commas (RFC 5322 address list separator)
    const chunks = headerValue.split(",");
    for (const chunk of chunks) {
      const candidate = extractCandidate(chunk);
      if (candidate) {
        candidates.push(normalizeAddress(candidate));
      }
    }
  }

  // Check for group matches (highest priority)
  for (const mapping of mappings) {
    if (!mapping.gmailGroupAddress) continue;
    const normalizedAddress = normalizeAddress(
      mapping.gmailGroupAddress.trim(),
    );
    if (candidates.includes(normalizedAddress)) {
      return mapping.email.trim().toLowerCase();
    }
  }

  // Fall back to catch-all
  const catchAll = mappings.find((m) => !m.gmailGroupAddress);
  return catchAll ? catchAll.email.trim().toLowerCase() : null;
}
