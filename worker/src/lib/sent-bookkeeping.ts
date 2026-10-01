import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { people } from "../db/people.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { computeConversationId, externalsOnly } from "./conversation-id";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/**
 * Sent-mail bookkeeping shared by the web composer (`sendEmail`) and the JMAP
 * submission adapter, so both record a Sent row the same way: the same person
 * row, and the same `conversation_id` for the same participants.
 */

/**
 * Fetch the set of "internal" domains (domains owned by our
 * sender_identities) for the current request — used to derive the
 * external-only participant list when computing a conversation_id.
 */
export async function fetchInternalDomains(db: Db): Promise<string[]> {
  const rows = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities);
  return Array.from(
    new Set(
      rows
        .map((r: { email: string }) => {
          const at = r.email.lastIndexOf("@");
          return at === -1 ? "" : r.email.slice(at + 1).toLowerCase();
        })
        .filter(Boolean),
    ),
  ) as string[];
}

/** The person row for an outbound recipient, created on first contact. */
export async function findOrCreatePersonId(
  db: Db,
  email: string,
  now: number,
): Promise<string> {
  const existing = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, email))
    .limit(1);
  if (existing[0]) return existing[0].id;

  await db
    .insert(people)
    .values({
      id: nanoid(),
      email,
      name: null,
      lastEmailAt: now,
      unreadCount: 0,
      totalCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: people.email });
  const refetched = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, email))
    .limit(1);
  return refetched[0]!.id;
}

/** conversation_id of an outbound message (null for 1:1 threads). */
export async function outboundConversationId(
  db: Db,
  inbox: string,
  to: string,
  cc: string[],
): Promise<string | null> {
  const externals = externalsOnly([to, ...cc], await fetchInternalDomains(db));
  return computeConversationId(inbox, externals);
}
