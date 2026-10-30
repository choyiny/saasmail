import { asc, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { deliveryEvents } from "../../db/delivery-events.schema";
import { jsonList } from "../inbox-permissions";
import type { UnifiedMessage } from "../messages/types";
import type { DeliveryEventKind } from "./types";

/** One problem a provider reported for a sent message, as the UI shows it. */
export interface DeliveryProblem {
  kind: DeliveryEventKind;
  bounceType: "hard" | "soft" | null;
  recipient: string;
  smtpStatus: string | null;
  detail: string | null;
  occurredAt: number;
}

/**
 * Sets `delivery.problems` on the page's sent messages: one query on
 * `delivery_events` by `sent_email_id`, the ids bound as one JSON parameter.
 */
export async function enrichDeliveryProblems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: DrizzleD1Database<any>,
  messages: UnifiedMessage[],
): Promise<void> {
  const sent = messages.filter(
    (message) => message.ref.kind === "sent" && message.delivery,
  );
  if (sent.length === 0) return;
  const rows = await db
    .select({
      sentEmailId: deliveryEvents.sentEmailId,
      kind: deliveryEvents.kind,
      bounceType: deliveryEvents.bounceType,
      recipient: deliveryEvents.recipient,
      smtpStatus: deliveryEvents.smtpStatus,
      detail: deliveryEvents.detail,
      occurredAt: deliveryEvents.occurredAt,
    })
    .from(deliveryEvents)
    .where(
      sql`${deliveryEvents.sentEmailId} IN ${jsonList(sent.map((m) => m.ref.id))}`,
    )
    .orderBy(asc(deliveryEvents.occurredAt));
  const grouped = new Map<string, DeliveryProblem[]>();
  for (const { sentEmailId, ...problem } of rows) {
    if (!sentEmailId) continue;
    const list = grouped.get(sentEmailId) ?? [];
    list.push(problem);
    grouped.set(sentEmailId, list);
  }
  for (const message of sent) {
    message.delivery!.problems = grouped.get(message.ref.id) ?? [];
  }
}
