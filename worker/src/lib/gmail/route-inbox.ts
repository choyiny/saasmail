import type { ParsedEmail } from "../email-parser";

export type InboxMapping = {
  email: string;
  /** Null means this mapping is the account's own mailbox — the catch-all. */
  gmailGroupAddress: string | null;
};

/**
 * Only these three headers decide routing. They are stamped by receiving infrastructure
 * (Delivered-To, X-Original-To) or the Group itself (List-ID) and cannot be forged by senders.
 * Removed: To, Cc — wholly sender-controlled with no integrity. Removing them deletes most
 * attack surface instead of trying to out-parse adversarial input.
 * Deliberately NOT the subject or body: a group address mentioned in prose must never redirect.
 */
const TRUSTED_HEADERS = ["delivered-to", "x-original-to", "list-id"];

/**
 * Strip RFC 5322 comments (parenthesised runs with nesting).
 */
function stripComments(value: string): string {
  let result = "";
  let depth = 0;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
    } else if (depth === 0) {
      result += char;
    }
  }

  return result;
}

/**
 * Extract a candidate address from a chunk of an RFC 5322 address list.
 * If the chunk contains angle brackets, extract the content of the FIRST pair.
 * If there is an addr-spec-like text before the bracket, reject (suspicious).
 * Otherwise, use the whole chunk trimmed.
 */
function extractAddress(chunk: string, allowBrackets: boolean): string | null {
  const trimmed = chunk.trim();

  const firstOpenBracket = trimmed.indexOf("<");
  if (firstOpenBracket !== -1) {
    // If this is a machine-generated header (not List-ID), reject if brackets present
    if (!allowBrackets) {
      return null;
    }

    // Check if text before bracket looks like an addr-spec (suspicious)
    if (firstOpenBracket > 0) {
      const beforeBracket = trimmed.substring(0, firstOpenBracket).trim();
      if (beforeBracket && isValidAddrSpec(beforeBracket)) {
        // Addr-spec before bracket: reject as suspicious
        return null;
      }
    }

    const firstCloseBracket = trimmed.indexOf(">", firstOpenBracket);
    if (firstCloseBracket > firstOpenBracket) {
      return trimmed.substring(firstOpenBracket + 1, firstCloseBracket);
    }
  }

  // No brackets, use whole chunk
  return trimmed;
}

/**
 * Validate that a candidate matches strict addr-spec syntax (for delivered-to, x-original-to).
 * Machine-generated headers have narrow grammar requiring exactly: localpart@domain.tld
 */
function isValidAddrSpec(candidate: string): boolean {
  // Require exactly: (non-special)+@(non-special)+.(non-special)+
  const addrSpecRegex = /^[^\s<>()@,;:"]+@[^\s<>()@,;:"]+\.[^\s<>()@,;:"]+$/;
  return addrSpecRegex.test(candidate);
}

export function resolveInbox(
  parsed: ParsedEmail,
  mappings: InboxMapping[],
): string | null {
  // Collect exact addresses from delivered-to and x-original-to
  const exactAddresses: string[] = [];

  // Collect List-ID values for dot-form comparison
  const listIdValues: string[] = [];

  // Process delivered-to
  const deliveredTo = parsed.headers?.["delivered-to"];
  if (deliveredTo && !deliveredTo.includes('"')) {
    // Machine-generated: reject if contains quotes (brackets are handled by extractAddress)
    const cleaned = stripComments(deliveredTo);
    const chunks = cleaned.split(",");
    for (const chunk of chunks) {
      const candidate = extractAddress(chunk, false);
      if (candidate && isValidAddrSpec(candidate)) {
        exactAddresses.push(candidate.toLowerCase().trim());
      }
    }
  }

  // Process x-original-to
  const xOriginalTo = parsed.headers?.["x-original-to"];
  if (xOriginalTo && !xOriginalTo.includes('"')) {
    // Machine-generated: reject if contains quotes (brackets are handled by extractAddress)
    const cleaned = stripComments(xOriginalTo);
    const chunks = cleaned.split(",");
    for (const chunk of chunks) {
      const candidate = extractAddress(chunk, false);
      if (candidate && isValidAddrSpec(candidate)) {
        exactAddresses.push(candidate.toLowerCase().trim());
      }
    }
  }

  // Process List-ID (allows brackets, single pair only)
  const listId = parsed.headers?.["list-id"];
  if (listId) {
    // Reject if contains quotes or multiple bracket pairs
    if (!listId.includes('"') && (listId.match(/</g) || []).length <= 1) {
      const cleaned = stripComments(listId);
      const chunks = cleaned.split(",");
      for (const chunk of chunks) {
        const candidate = extractAddress(chunk, true);
        if (candidate) {
          listIdValues.push(candidate.toLowerCase().trim());
        }
      }
    }
  }

  // Check for group matches
  for (const mapping of mappings) {
    if (!mapping.gmailGroupAddress) continue;

    const mappingEmail = mapping.gmailGroupAddress.trim().toLowerCase();

    // Exact match for delivered-to and x-original-to
    if (exactAddresses.includes(mappingEmail)) {
      return mapping.email.trim().toLowerCase();
    }

    // Dot-form match for list-id
    const dotForm = mappingEmail.replace("@", ".");
    if (listIdValues.includes(dotForm)) {
      return mapping.email.trim().toLowerCase();
    }
  }

  // Fall back to catch-all
  const catchAll = mappings.find((m) => !m.gmailGroupAddress);
  return catchAll ? catchAll.email.trim().toLowerCase() : null;
}
