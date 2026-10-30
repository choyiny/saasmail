import type { DrizzleD1Database } from "drizzle-orm/d1";
import { senderIdentities } from "../db/sender-identities.schema";
import type { MailAddress, UnifiedMessage } from "./messages/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** Every inbox address of this instance, lowercased. */
export async function ownInboxAddresses(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities);
  return new Set(
    rows.map((row: { email: string }) => row.email.trim().toLowerCase()),
  );
}

/**
 * The Reply-To addresses a reply may be sent to: the message's list without
 * our own inboxes and without the inbox the reply goes out from. This is the
 * loop guard: a Reply-To that points back at us never makes us mail
 * ourselves. Empty means the reply goes to the sender.
 */
export function replyCandidates(
  replyTo: MailAddress[],
  ownInboxes: ReadonlySet<string>,
  fromInbox?: string,
): MailAddress[] {
  const from = fromInbox?.trim().toLowerCase();
  return replyTo.filter((entry) => {
    const email = entry.email.trim().toLowerCase();
    return !ownInboxes.has(email) && email !== from;
  });
}

/**
 * Every address a reply would be sent to when it follows Reply-To: the first
 * is To, the others are copied. Empty when that is nobody but the sender,
 * i.e. when following Reply-To changes nothing.
 */
export function replyRecipients(
  candidates: MailAddress[],
  senderEmail: string | null | undefined,
): MailAddress[] {
  const sender = senderEmail?.trim().toLowerCase();
  const onlySender =
    candidates.length === 1 &&
    candidates[0].email.trim().toLowerCase() === sender;
  return candidates.length === 0 || onlySender ? [] : candidates;
}

/**
 * The one address the `Email`-shaped routes report as `replyTo`: the first
 * candidate, unless that is the sender anyway.
 */
export function replyTarget(
  candidates: MailAddress[],
  senderEmail: string | null | undefined,
): string | null {
  const first = candidates[0]?.email.trim().toLowerCase();
  if (!first) return null;
  return first === senderEmail?.trim().toLowerCase() ? null : first;
}

/**
 * Replaces each message's Reply-To list (as read with `withReplyTo`) by the
 * addresses a reply would use (`replyRecipients`), so an HTTP response says
 * where a reply would go. A browser cannot do this itself: a member only
 * knows the inboxes they were granted. The inbox a message arrived at is
 * what a reply is sent from, so it is never offered either.
 * Reads the identities once, and not at all when no message has a Reply-To.
 */
export async function applyReplyGuard(
  db: Db,
  messages: UnifiedMessage[],
): Promise<void> {
  if (!messages.some((message) => (message.replyTo?.length ?? 0) > 0)) return;
  const own = await ownInboxAddresses(db);
  for (const message of messages) {
    if (!message.replyTo) continue;
    message.replyTo = replyRecipients(
      replyCandidates(message.replyTo, own, message.inbox),
      message.from?.email,
    );
  }
}
