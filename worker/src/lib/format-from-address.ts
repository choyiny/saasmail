import { eq } from "drizzle-orm";
import { senderIdentities } from "../db/sender-identities.schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";

/**
 * RFC 5322 "specials" — a display-name containing any of these is not a valid
 * bare atom sequence and must be sent as a quoted-string instead.
 *
 * The comma matters most in practice: providers split the From header on commas
 * to find multiple addresses, so an unquoted `Ada, VP of Engineering` is parsed
 * as an address list whose first entry is the bare word `Ada` — and the whole
 * send is rejected ("Illegal email address 'Ada'").
 */
const RFC5322_SPECIALS = /[()<>[\]:;@\\,."]/;

/**
 * Encodes a display-name for use in a From header, quoting and escaping it
 * when it contains characters that can't appear in a bare atom.
 */
export function encodeDisplayName(name: string): string {
  if (!RFC5322_SPECIALS.test(name)) return name;
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Looks up the display name for an email address and returns
 * a formatted "From" string for the sending provider.
 *
 * Returns "Display Name <email>" if a display name is configured,
 * otherwise returns the bare email address.
 */
export async function formatFromAddress(
  db: DrizzleD1Database<any>,
  email: string,
): Promise<string> {
  const rows = await db
    .select({ displayName: senderIdentities.displayName })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, email))
    .limit(1);

  if (rows.length > 0 && rows[0].displayName) {
    return `${encodeDisplayName(rows[0].displayName)} <${email}>`;
  }
  return email;
}
