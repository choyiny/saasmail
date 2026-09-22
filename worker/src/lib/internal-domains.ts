import type { DrizzleD1Database } from "drizzle-orm/d1";
import { senderIdentities } from "../db/sender-identities.schema";

/**
 * The domains saasmail itself owns, derived from every sender identity.
 *
 * This is the input to `externalsOnly`, which is the input to
 * `computeConversationId` — so it decides which participants define a
 * conversation. Three paths now compute a `conversation_id` for the same
 * thread (inbound mail, an outbound send or reply, and a message mirrored
 * out of a Gmail Sent folder), and they agree only while they derive these
 * domains identically. They each held a verbatim copy of this, and a copy
 * that drifted would silently fork a thread in two rather than fail.
 *
 * `lastIndexOf("@")` because a quoted local part may legally contain one;
 * lowercased because domains are case-insensitive and the identity table is
 * not guaranteed to be; blanks dropped so a malformed row cannot make every
 * address look internal.
 */
export function internalDomainsFrom(rows: { email: string }[]): string[] {
  return Array.from(
    new Set(
      rows
        .map((r) => {
          const at = r.email.lastIndexOf("@");
          return at === -1 ? "" : r.email.slice(at + 1).toLowerCase();
        })
        .filter(Boolean),
    ),
  );
}

/** `internalDomainsFrom` over every sender identity in the database. */
export async function fetchInternalDomains(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: DrizzleD1Database<any>,
): Promise<string[]> {
  const rows = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities);
  return internalDomainsFrom(rows);
}
