import { and, eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import {
  deliveryEvents,
  deliveryMessageIds,
} from "../../db/delivery-events.schema";
import { listMembers } from "../../db/list-members.schema";
import { sentEmails } from "../../db/sent-emails.schema";
import { suppressions } from "../../db/suppressions.schema";
import { AUDIT_ACTIONS } from "../audit/events";
import { recordAudit } from "../audit/record";
import { bracketedMessageId } from "../message-id";
import type {
  DeliveryCorrelation,
  DeliveryEvent,
  DeliveryEventOutcome,
  DeliverySuppressionReason,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** Soft bounces for one address within the window that suppress it. */
export const SOFT_BOUNCE_THRESHOLD = 3;
export const SOFT_BOUNCE_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** The stored id of an event: a redelivery conflicts on it. */
export function deliveryEventId(event: DeliveryEvent): string {
  return `${event.provider}:${event.providerEventId}`;
}

/**
 * The sent message an event is about: an indexed read on
 * `sent_emails.message_id`, then on the copies' ids. Null without a message
 * id or a match.
 */
export async function correlateDeliveryEvent(
  db: Db,
  event: DeliveryEvent,
): Promise<DeliveryCorrelation | null> {
  const messageId = event.messageId?.trim();
  if (!messageId) return null;
  const bracketed = bracketedMessageId(messageId);
  const columns = { id: sentEmails.id, campaignId: sentEmails.campaignId };
  let [row] = await db
    .select(columns)
    .from(sentEmails)
    .where(eq(sentEmails.messageId, bracketed))
    .limit(1);
  if (!row) {
    // A further copy of a per-recipient send (`delivery_message_ids`).
    [row] = await db
      .select(columns)
      .from(deliveryMessageIds)
      .innerJoin(sentEmails, eq(sentEmails.id, deliveryMessageIds.sentEmailId))
      .where(eq(deliveryMessageIds.messageId, bracketed))
      .limit(1);
  }
  return row ? { sentEmailId: row.id, campaignId: row.campaignId } : null;
}

/** Statements an event adds to its batch; each must carry `guard`. */
export type DeliveryBatchExtension = (context: {
  db: Db;
  outcome: DeliveryEventOutcome;
  /** `NOT EXISTS (the event row)`: put it in the statement's WHERE. */
  guard: SQL;
}) => unknown[];

export interface RecordDeliveryEventOptions {
  /** A correlation the caller already looked up (undefined: look it up). */
  correlation?: DeliveryCorrelation | null;
  /** More guarded statements for the same batch, before the event row. */
  extend?: DeliveryBatchExtension;
  now?: number;
}

/** What this event suppresses outright; soft bounces are decided in SQL. */
function suppressionFor(
  event: DeliveryEvent,
): DeliverySuppressionReason | null {
  if (event.kind === "bounced" && event.bounceType === "hard") {
    return "hard_bounce";
  }
  if (event.kind === "complained") return "complaint";
  if (event.kind === "rejected" && event.rejectionReason === "suppressed") {
    return "provider";
  }
  return null;
}

/**
 * Record one delivery event and apply what it means (docs/suppressions.md):
 * the event row, the suppression and the list unsubscribes commit in one D1
 * batch. The effects before the event row are guarded by its absence, the
 * soft-bounce suppression after it by its insert, so a redelivered event
 * changes nothing and returns null, and a failed batch leaves nothing for the
 * queue's retry to trip over.
 */
export async function recordDeliveryEvent(
  db: Db,
  event: DeliveryEvent,
  opts: RecordDeliveryEventOptions = {},
): Promise<DeliveryEventOutcome | null> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const id = deliveryEventId(event);
  const correlation =
    opts.correlation !== undefined
      ? opts.correlation
      : await correlateDeliveryEvent(db, event);

  const suppression = suppressionFor(event);
  const leavesLists =
    suppression === "hard_bounce" || suppression === "complaint";
  const outcome: DeliveryEventOutcome = {
    event,
    sentEmailId: correlation?.sentEmailId ?? null,
    campaignId: correlation?.campaignId ?? null,
    suppression,
    listsLeft: 0,
  };

  const guard = sql`NOT EXISTS (SELECT 1 FROM delivery_events WHERE id = ${id})`;
  // Query builders, not `db.run`: only builders go into a D1 batch here.
  const statements: unknown[] = [];
  if (suppression) {
    const insert = db
      .insert(suppressions)
      .select(
        sql`SELECT ${nanoid()}, ${event.recipient}, ${suppression}, ${event.provider}, ${event.smtpStatus}, ${now} WHERE ${guard}`,
      );
    // A hard bounce outranks whatever reason the address had; the others
    // keep an existing row as it is.
    statements.push(
      suppression === "hard_bounce"
        ? insert.onConflictDoUpdate({
            target: suppressions.email,
            set: {
              reason: "hard_bounce",
              source: sql`excluded.source`,
              note: sql`excluded.note`,
            },
          })
        : insert.onConflictDoNothing({ target: suppressions.email }),
    );
  }
  const listIndex = statements.length;
  if (leavesLists) {
    statements.push(
      db
        .update(listMembers)
        .set({
          status: "unsubscribed",
          unsubscribedAt: now,
          unsubscribeReason: suppression,
        })
        .where(
          and(
            eq(listMembers.email, event.recipient),
            eq(listMembers.status, "subscribed"),
            guard,
          ),
        ),
    );
  }
  if (opts.extend) statements.push(...opts.extend({ db, outcome, guard }));
  const eventIndex = statements.length;
  statements.push(
    db
      .insert(deliveryEvents)
      .values({
        id,
        provider: event.provider,
        kind: event.kind,
        bounceType: event.bounceType,
        sentEmailId: outcome.sentEmailId,
        campaignId: outcome.campaignId,
        messageId: event.messageId?.trim()
          ? bracketedMessageId(event.messageId)
          : null,
        recipient: event.recipient,
        sender: event.sender,
        smtpStatus: event.smtpStatus,
        detail: event.detail,
        occurredAt: event.occurredAt,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: deliveryEvents.id }),
  );
  const isSoft = event.kind === "bounced" && event.bounceType === "soft";
  if (isSoft) statements.push(softBounceSuppression(db, event, now));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = (await db.batch(statements as any)) as unknown[];
  const inserted = results[eventIndex] as { id: string }[];
  if (inserted.length === 0) return null;
  // Reported only when this event added the row: an address already
  // suppressed for another reason keeps it.
  if (isSoft && (results[eventIndex + 1] as unknown[]).length > 0) {
    outcome.suppression = "soft_bounce";
  }
  if (leavesLists) {
    const changed = results[listIndex] as { meta?: { changes?: number } };
    outcome.listsLeft = changed?.meta?.changes ?? 0;
  }

  await recordAudit(db, {
    action:
      AUDIT_ACTIONS[
        event.kind === "bounced"
          ? "mailBounced"
          : event.kind === "complained"
            ? "mailComplained"
            : event.kind === "rejected"
              ? "mailRejected"
              : "mailFailed"
      ],
    targetType: "message",
    targetId: outcome.sentEmailId ? `sent:${outcome.sentEmailId}` : null,
    inbox: event.sender,
    // Never the recipient's address (docs/audit-log.md).
    summary: summaryOf(event, outcome),
  });
  return outcome;
}

/**
 * The soft-bounce suppression, decided inside the batch right after the event
 * row so concurrent events serialize: D1 runs a batch as one transaction, and
 * the last of three sees all three. `changes() = 1` means the insert just
 * before it added the event (a redelivery adds nothing). The rule: some
 * 30-day window holding this event holds `SOFT_BOUNCE_THRESHOLD` soft
 * bounces. Each such window starts at a soft bounce no more than 30 days
 * before this one, so the anchors are those; events arriving out of order
 * count by when they occurred, and an old one cannot reach recent ones.
 */
function softBounceSuppression(db: Db, event: DeliveryEvent, now: number) {
  const window = SOFT_BOUNCE_WINDOW_SECONDS;
  return db
    .insert(suppressions)
    .select(
      sql`SELECT ${nanoid()}, ${event.recipient}, 'soft_bounce', ${event.provider}, ${event.smtpStatus}, ${now}
          WHERE changes() = 1 AND EXISTS (
            SELECT 1 FROM delivery_events a
             WHERE a.recipient = ${event.recipient} AND a.kind = 'bounced' AND a.bounce_type = 'soft'
               AND a.occurred_at BETWEEN ${event.occurredAt - window} AND ${event.occurredAt}
               AND (SELECT COUNT(*) FROM delivery_events b
                     WHERE b.recipient = a.recipient AND b.kind = 'bounced' AND b.bounce_type = 'soft'
                       AND b.occurred_at BETWEEN a.occurred_at AND a.occurred_at + ${window}) >= ${SOFT_BOUNCE_THRESHOLD})`,
    )
    .onConflictDoNothing({ target: suppressions.email })
    .returning({ id: suppressions.id });
}

function summaryOf(
  event: DeliveryEvent,
  outcome: DeliveryEventOutcome,
): string {
  const what =
    event.kind === "bounced"
      ? `${event.bounceType === "hard" ? "Hard" : event.bounceType === "soft" ? "Soft" : "A"} bounce`
      : event.kind === "complained"
        ? "Spam complaint"
        : event.kind === "rejected"
          ? "Rejected by the provider"
          : "Delivery failed";
  const parts = [
    `${what}${event.smtpStatus ? ` (${event.smtpStatus})` : ""}`,
    outcome.sentEmailId ? null : "no matching sent message",
    outcome.suppression ? `suppressed as ${outcome.suppression}` : null,
    outcome.listsLeft > 0 ? `left ${outcome.listsLeft} list(s)` : null,
  ].filter(Boolean);
  return parts.join("; ");
}
