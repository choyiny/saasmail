import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { appSettings } from "../db/app-settings.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { currentAuditActor } from "./audit/context";
import { AUDIT_ACTIONS } from "./audit/events";
import { recordAudit } from "./audit/record";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export const REJECT_UNKNOWN_RECIPIENTS_KEY = "reject_unknown_recipients";
/** The SMTP reply for mail to an address that is not an inbox. */
export const UNKNOWN_RECIPIENT_REASON = "No such mailbox";

/** Whether mail to an address that is not an inbox is refused (default off). */
export async function rejectsUnknownRecipients(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, REJECT_UNKNOWN_RECIPIENTS_KEY))
    .limit(1);
  return row?.value === "true";
}

/**
 * Whether an address is one of ours for unknown-recipient rejection: it has a
 * sender identity, or members are assigned to it. An address that only
 * received mail through the catch-all is not.
 */
export async function hasInboxMembers(
  db: Db,
  address: string,
): Promise<boolean> {
  const [row] = await db
    .select({ email: inboxPermissions.email })
    .from(inboxPermissions)
    .where(sql`lower(${inboxPermissions.email}) = ${address}`)
    .limit(1);
  return row !== undefined;
}

/**
 * Addresses that received mail in the last `days` days but are not inboxes
 * (no identity, no members): what turning rejection on would start to
 * refuse. Busiest first, at most 50.
 */
export async function recentUnknownRecipients(
  db: Db,
  input: { now: number; days?: number },
): Promise<{ address: string; count: number; lastReceivedAt: number }[]> {
  const since = input.now - (input.days ?? 30) * 24 * 60 * 60;
  const rows = await db.all<{
    recipient: string;
    count: number;
    last_received_at: number;
  }>(sql`
    SELECT recipient, COUNT(*) AS count, MAX(received_at) AS last_received_at
    FROM emails
    WHERE received_at >= ${since}
      AND recipient NOT IN (SELECT lower(email) FROM sender_identities)
      AND recipient NOT IN (SELECT lower(email) FROM inbox_permissions)
    GROUP BY recipient
    ORDER BY count DESC, recipient
    LIMIT 50
  `);
  return rows.map((row) => ({
    address: row.recipient,
    count: Number(row.count),
    lastReceivedAt: Number(row.last_received_at),
  }));
}

/** Turns unknown-recipient rejection on or off, as the current actor. */
export async function setRejectUnknownRecipients(
  db: Db,
  on: boolean,
): Promise<void> {
  const before = await rejectsUnknownRecipients(db);
  if (before === on) return;
  const actor = currentAuditActor();
  const now = Math.floor(Date.now() / 1000);
  const value = on ? "true" : "false";
  await db
    .insert(appSettings)
    .values({
      key: REJECT_UNKNOWN_RECIPIENTS_KEY,
      value,
      updatedAt: now,
      updatedBy: actor.actorUserId,
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now, updatedBy: actor.actorUserId },
    });
  await recordAudit(db, {
    action: AUDIT_ACTIONS.settingsChanged,
    targetType: "setting",
    targetId: REJECT_UNKNOWN_RECIPIENTS_KEY,
    summary: on
      ? "Turned on rejecting mail to addresses that aren't inboxes"
      : "Turned off rejecting mail to addresses that aren't inboxes",
    details: { key: REJECT_UNKNOWN_RECIPIENTS_KEY, from: before, to: on },
  });
}

/**
 * `inbound.rejected`: a message refused at SMTP time, as the current actor
 * (the rule that refused it, or the system for an unknown recipient).
 * Nothing else is written for it.
 */
export async function recordInboundRejection(
  db: Db,
  input: {
    from: string;
    recipient: string;
    subject: string | null;
    messageId: string | null;
    reason: string;
    ruleId?: string;
    ruleName?: string;
  },
): Promise<void> {
  await recordAudit(db, {
    action: AUDIT_ACTIONS.inboundRejected,
    targetType: input.ruleId ? "rule" : "inbox",
    targetId: input.ruleId ?? input.recipient,
    inbox: input.recipient,
    summary: input.ruleId
      ? `Rejected mail from ${input.from} to ${input.recipient} by the rule '${input.ruleName ?? input.ruleId}'`
      : `Rejected mail from ${input.from} to ${input.recipient}: not an inbox`,
    details: {
      from: input.from,
      recipient: input.recipient,
      subject: input.subject,
      messageId: input.messageId,
      reason: input.reason,
      ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    },
  });
}
