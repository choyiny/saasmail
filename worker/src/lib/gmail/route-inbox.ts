/**
 * Decide which saasmail inbox(es) a message from a connected Gmail account
 * belongs to.
 *
 * One Google mailbox can back several inboxes: the account's own address plus
 * any "Send mail as" aliases it holds (`hello@` delivered into `choyin@`'s
 * mailbox). The mapping route only accepts an address the account can send
 * as, so every mapped address is one of those.
 *
 * WHY THE To:/Cc: LINES, AND WHY NOT Delivered-To / List-ID.
 *
 * Gmail stamps Delivered-To with the PRIMARY address for alias mail, so it
 * cannot tell `hello@` from `choyin@` at all — and it was already rejected as
 * forgeable via duplicate-header collapse (the parser takes last-wins). The
 * only place an alias's address survives is the recipient lines the sender
 * wrote. Those are sender-controlled too, and that is accepted here on
 * purpose: every mapped address is a real, publicly deliverable alias of the
 * same mailbox, so a sender who forges `To: hello@` gets exactly what they
 * would by mailing `hello@` directly. A forged header can only move the
 * forger's OWN message between inboxes the same team already reads; it cannot
 * redirect anyone else's mail. (saasmail's trust model is one team.)
 *
 * Google Group mappings (`gmailGroupAddress !== null`) are still not accepted
 * by the admin route and are ignored here.
 */

export type InboxMapping = {
  email: string;
  /** Null means a plain address of this account — its own or an alias. */
  gmailGroupAddress: string | null;
};

function normalize(address: string): string {
  return address.trim().toLowerCase();
}

/** The mapped inbox addresses, normalized, groups dropped, de-duplicated. */
export function mappedAddresses(mappings: InboxMapping[]): string[] {
  const out: string[] = [];
  for (const m of mappings) {
    if (m.gmailGroupAddress !== null) continue;
    const address = normalize(m.email);
    if (address && !out.includes(address)) out.push(address);
  }
  return out;
}

/**
 * Where mail that names no mapped address goes: Bcc'd mail, mailing lists,
 * anything forwarded in.
 *
 * The inbox at the account's own address, when mapped — that is whose mailbox
 * it is. Otherwise the only mapping, when there is exactly one, which keeps a
 * single-inbox setup taking everything as it always has. Otherwise nobody: with
 * only aliases mapped, mail to the person themselves is not one alias's to
 * claim, and picking by row order would make the answer depend on the database.
 */
export function fallbackInbox(
  inboxes: string[],
  accountAddress: string,
): string | null {
  const own = normalize(accountAddress);
  if (inboxes.includes(own)) return own;
  if (inboxes.length === 1) return inboxes[0];
  return null;
}

/**
 * The inboxes one RECEIVED message lands in.
 *
 * Every mapped inbox the message names on To: or Cc:, in mapping order — one
 * message to two of our aliases is two deliveries, which the per-inbox dedupe
 * in `ingestParsedEmail` is built for. When it names none, the fallback above.
 * An empty result means "skip": no inbox is entitled to it.
 */
export function resolveInboundInboxes(
  inboxes: string[],
  accountAddress: string,
  addressed: string[],
): string[] {
  const named = new Set(addressed.map(normalize));
  const matched = inboxes.filter((inbox) => named.has(inbox));
  if (matched.length > 0) return matched;
  const fallback = fallbackInbox(inboxes, accountAddress);
  return fallback ? [fallback] : [];
}

/**
 * The inbox a message from the mailbox's own SENT folder is filed under: the
 * mapped address it was sent FROM, else the fallback.
 *
 * Unlike inbound mail, the writer here is the account itself, so From: is
 * trustworthy — it is whichever send-as identity the person picked in Gmail.
 */
export function resolveSentInbox(
  inboxes: string[],
  accountAddress: string,
  fromAddress: string | null,
): string | null {
  const from = fromAddress ? normalize(fromAddress) : "";
  if (from && inboxes.includes(from)) return from;
  return fallbackInbox(inboxes, accountAddress);
}
