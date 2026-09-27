import { nanoid } from "nanoid";
import type { SendEmailResult } from "./email-sender/types";

/**
 * Build an RFC 5322 Message-ID from a bare email address.
 * The returned value includes surrounding angle brackets, e.g. `<abc123@example.com>`.
 * Throws if `fromAddress` does not contain an `@` (callers must pass a plain address,
 * not a `"Display" <addr>` formatted string).
 */
export function generateMessageId(fromAddress: string): string {
  const at = fromAddress.lastIndexOf("@");
  if (at < 0) {
    throw new Error(`Invalid from address (missing @): ${fromAddress}`);
  }
  const domain = fromAddress.slice(at + 1);
  return `<${nanoid()}@${domain}>`;
}

/**
 * The Message-ID a sent message actually carries on the wire: the provider's
 * own when it replaced ours (`SendEmailResult.deliveredMessageId`), otherwise the
 * one we submitted. `sent_emails.message_id` stores this, so a later reply's
 * `In-Reply-To` cites an id the recipient has. Always bracketed.
 */
export function deliveredMessageId(
  submitted: string,
  result: SendEmailResult | null | undefined,
): string {
  const delivered = result?.deliveredMessageId?.trim();
  if (!delivered) return submitted;
  return delivered.startsWith("<") ? delivered : `<${delivered}>`;
}
