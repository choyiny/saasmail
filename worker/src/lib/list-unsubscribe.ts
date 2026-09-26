import { and, eq, ne } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { campaigns } from "../db/campaigns.schema";
import { campaignUnsubscribeAttributions } from "../db/campaign-unsubscribe-attributions.schema";
import { listMembers } from "../db/list-members.schema";

type Db = DrizzleD1Database<any>;

/**
 * How long a one-click re-subscribe stays available after unsubscribing.
 *
 * The undo button exists for the misclick, not as a permanent re-entry point:
 * a token lives in an email forever, so without a window anyone holding a
 * forwarded copy could re-subscribe an address indefinitely. After it closes,
 * coming back requires a fresh opt-in through the public form.
 */
export const RESUBSCRIBE_UNDO_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/** The parts of a verified v2 token this module acts on. */
export type V2Unsubscribe = {
  listId: string;
  campaignId: string;
  contactId: string;
};

/**
 * Nullable-`error` rather than a discriminated union: the worker tsconfig does
 * not enable `strict`, so `if (!result.ok)` narrows nothing and every field
 * access on the failure branch would be an error. One always-present `error`
 * field reads the same and actually type-checks here.
 */
export type ListUnsubscribeResult = {
  /** `null` when the operation applied. */
  error: "invalid" | "window_closed" | null;
  email?: string;
  listId?: string;
};

/**
 * Resolve a v2 token to the membership row it addresses.
 *
 * The campaign→list check is the security-relevant half: a token names both,
 * and a signature proves only that *we* minted the pair, not that the pair is
 * still coherent. Refusing a campaign that doesn't belong to the token's list
 * means a token can never reach a membership outside the list it was issued
 * for, even if campaigns are later moved or recreated.
 */
async function resolveMember(db: Db, token: V2Unsubscribe) {
  const campaignRows = await db
    .select({ listId: campaigns.listId })
    .from(campaigns)
    .where(eq(campaigns.id, token.campaignId))
    .limit(1);

  const campaign = campaignRows[0];
  if (!campaign || campaign.listId !== token.listId) return null;

  const memberRows = await db
    .select({
      id: listMembers.id,
      email: listMembers.email,
      status: listMembers.status,
      subscribedAt: listMembers.subscribedAt,
      unsubscribedAt: listMembers.unsubscribedAt,
    })
    .from(listMembers)
    .where(
      and(
        eq(listMembers.listId, token.listId),
        eq(listMembers.contactId, token.contactId),
      ),
    )
    .limit(1);

  return memberRows[0] ?? null;
}

/**
 * Remove a membership and credit the campaign that prompted it.
 *
 * Both writes go out in one D1 batch and both are no-ops on replay — the
 * attribution insert conflicts away, the membership update is guarded by
 * `status != 'unsubscribed'`. That is what makes the near-simultaneous pair a
 * real unsubscribe produces (a client's RFC 8058 one-click POST plus the
 * human's own click on the same link) attribute exactly once, with no
 * read-then-write window between them.
 *
 * Deliberately does **not** touch global `suppressions`: leaving one list is
 * not consent withdrawal for transactional mail or for any other list.
 */
export async function applyListUnsubscribe(
  db: Db,
  token: V2Unsubscribe,
  opts: { reason: string; now?: number },
): Promise<ListUnsubscribeResult> {
  const member = await resolveMember(db, token);
  if (!member) return { error: "invalid" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);

  await db.batch([
    db
      .insert(campaignUnsubscribeAttributions)
      .values({
        id: nanoid(),
        campaignId: token.campaignId,
        listMemberId: member.id,
        occurredAt: now,
      })
      .onConflictDoNothing({
        target: [
          campaignUnsubscribeAttributions.campaignId,
          campaignUnsubscribeAttributions.listMemberId,
        ],
      }),
    db
      .update(listMembers)
      .set({
        status: "unsubscribed",
        unsubscribedAt: now,
        unsubscribeReason: opts.reason,
      })
      .where(
        and(
          eq(listMembers.id, member.id),
          ne(listMembers.status, "unsubscribed"),
        ),
      ),
  ]);

  return { error: null, email: member.email, listId: token.listId };
}

/**
 * Undo a list unsubscribe, within the window.
 *
 * Drops the attribution as well as restoring the membership, because
 * `statsUnsubscribes` is a live `COUNT(*)` over that table — an undone
 * unsubscribe that stayed counted would permanently overstate the campaign.
 */
export async function undoListUnsubscribe(
  db: Db,
  token: V2Unsubscribe,
  opts: { now?: number } = {},
): Promise<ListUnsubscribeResult> {
  const member = await resolveMember(db, token);
  if (!member) return { error: "invalid" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);

  // Already back on the list — report success rather than an error, so a
  // double-tapped undo button doesn't look like a failure.
  if (member.status !== "unsubscribed") {
    return { error: null, email: member.email, listId: token.listId };
  }

  const unsubscribedAt = member.unsubscribedAt;
  if (
    unsubscribedAt === null ||
    now - unsubscribedAt > RESUBSCRIBE_UNDO_WINDOW_SECONDS
  ) {
    return { error: "window_closed" };
  }

  await db.batch([
    db
      .delete(campaignUnsubscribeAttributions)
      .where(
        and(
          eq(campaignUnsubscribeAttributions.campaignId, token.campaignId),
          eq(campaignUnsubscribeAttributions.listMemberId, member.id),
        ),
      ),
    db
      .update(listMembers)
      .set({
        status: "subscribed",
        unsubscribedAt: null,
        unsubscribeReason: null,
        subscribedAt: member.subscribedAt ?? now,
      })
      .where(eq(listMembers.id, member.id)),
  ]);

  return { error: null, email: member.email, listId: token.listId };
}
