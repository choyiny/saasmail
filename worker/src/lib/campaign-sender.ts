import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { asyncJobs } from "../db/async-jobs.schema";
import { campaigns } from "../db/campaigns.schema";
import { campaignEvents } from "../db/campaign-events.schema";
import { campaignUnsubscribeAttributions } from "../db/campaign-unsubscribe-attributions.schema";
import { campaignRecipients } from "../db/campaign-recipients.schema";
import { contacts } from "../db/contacts.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import type { EmailSender } from "./email-sender";
import { findPersonIdByEmail } from "./find-person";
import { formatFromAddress } from "./format-from-address";
import {
  applyRecipientTracking,
  rewriteCampaignLinks,
} from "./campaign-tracking";
import { htmlToText } from "./html-to-text";
import { interpolate } from "./interpolate";
import { generateMessageId } from "./message-id";
import { finalizeOutboxRow, sendViaOutbox } from "./outbox";
import { signPayload } from "./signed-token";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export interface CampaignFanOutMessage {
  type: "campaign_fan_out";
  campaignId: string;
  jobId: string;
}

export interface CampaignSendMessage {
  type: "campaign_send";
  campaignId: string;
  campaignRecipientId: string;
}

/**
 * Recipients enumerated and enqueued per coordinator invocation.
 *
 * Chosen to match Cloudflare Queues' `sendBatch()` limit of 100 messages /
 * 256 KB. It is *not* a D1 "100 statements per batch" limit — no such limit
 * exists; D1's cap is 100 bound parameters per query, a different constraint.
 */
export const FAN_OUT_PAGE_SIZE = 100;

/**
 * Statement-level chunk sizes, set by D1's cap on bound variables per query.
 *
 * These are not tuning knobs. A `campaign_recipients` row binds 12 variables,
 * so 8 rows is 96 — under the cap with room to spare if a column is ever added.
 * An `IN` list binds one per id, plus one for the campaign id.
 */
const INSERT_CHUNK_ROWS = 8;
const SELECT_CHUNK_IDS = 80;

/** Reserved variables every campaign template can use. */
export type ReservedVars = {
  unsubscribe_url: string;
  subscriber_name: string;
  subscriber_email: string;
};

// --- Content snapshot ---

/**
 * Freeze what will actually be sent.
 *
 * After this runs the campaign no longer reads its own editable body: editing
 * the campaign afterwards cannot change mail that is already going out. That is
 * the whole point — a half-sent campaign whose content changed mid-flight would
 * deliver two different emails under one name.
 *
 * The content is the campaign's own `bodyHtml`. It used to be looked up from
 * the referenced template, which is why a campaign could not be edited at all;
 * `templateSlug` is now only a record of what the campaign was seeded from.
 */
export async function snapshotCampaign(
  db: Db,
  campaignId: string,
  now: number,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  const campaign = rows[0];
  if (!campaign) return "Campaign not found";

  // An empty body is refused here rather than mailing a blank message to a
  // list. This is the last point at which the operator can still fix it — once
  // recipients are claimed they are not re-claimable.
  if (!campaign.bodyHtml.trim()) {
    return "Campaign has no content — add a body before sending";
  }

  const subject = campaign.subject;

  // The text part is derived from the *unrewritten* HTML, deliberately: click
  // tracking is an HTML-part feature, and a plain-text body full of opaque
  // redirect URLs reads as phishing to filters and humans alike.
  const text = campaign.textBodyOverride ?? htmlToText(campaign.bodyHtml);

  // Link rewriting happens once here rather than per recipient. What lands in
  // the snapshot is an opaque marker per link; the send path swaps in each
  // recipient's signed URL. Running before interpolation is also what protects
  // `{{unsubscribe_url}}` — it is still a placeholder at this point and is
  // recognised structurally instead of by matching a URL after the fact.
  const html = await rewriteCampaignLinks(
    db,
    campaignId,
    campaign.bodyHtml,
    now,
  );

  await db
    .update(campaigns)
    .set({
      contentSnapshotAt: now,
      subjectSnapshot: subject,
      htmlSnapshot: html,
      textSnapshot: text,
      fromAddressSnapshot: campaign.fromAddress,
      templateRevision: `${campaign.id}@${campaign.updatedAt}`,
      updatedAt: now,
    })
    .where(eq(campaigns.id, campaignId));

  // null means "snapshotted"; a string is the reason it could not be.
  return null;
}

// --- Fan-out ---

/**
 * Enumerate one page of subscribed members and enqueue a send for each.
 *
 * The cursor advances **only after** both the recipient insert and the
 * `sendBatch()` have succeeded. Queues gives no reliable per-message success
 * list for a rejected batch, so any non-success is treated as ambiguous
 * publication rather than partial success: the cursor stays put and the whole
 * page replays. That is safe precisely because the inserts are conflict-ignored
 * and the per-recipient claim makes a duplicate message a no-op.
 */
export async function runCampaignFanOutPage(
  db: Db,
  env: CloudflareBindings,
  campaignId: string,
  jobId: string,
): Promise<void> {
  const jobs = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId))
    .limit(1);
  const job = jobs[0];
  if (!job) throw new Error(`Fan-out job ${jobId} not found`);
  if (job.status !== "running") return;

  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  const campaign = rows[0];
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (campaign.status === "cancelled") return;

  const now = Math.floor(Date.now() / 1000);

  // First invocation: fix the target count and flip to sending.
  if (campaign.status === "preparing") {
    const counted = await db
      .select({ n: sql<number>`count(*)` })
      .from(listMembers)
      .where(
        and(
          eq(listMembers.listId, campaign.listId),
          eq(listMembers.status, "subscribed"),
        ),
      );
    await db
      .update(campaigns)
      .set({
        status: "sending",
        statsTargeted: Number(counted[0]?.n ?? 0),
        updatedAt: now,
      })
      .where(eq(campaigns.id, campaignId));
  }

  const cursor = job.cursor;
  const conditions = [
    eq(listMembers.listId, campaign.listId),
    eq(listMembers.status, "subscribed"),
  ];
  if (cursor) conditions.push(sql`${listMembers.id} > ${cursor}`);

  const page = await db
    .select({
      id: listMembers.id,
      contactId: listMembers.contactId,
      email: listMembers.email,
    })
    .from(listMembers)
    .where(and(...conditions))
    .orderBy(asc(listMembers.id))
    .limit(FAN_OUT_PAGE_SIZE);

  if (page.length === 0) {
    await db
      .update(asyncJobs)
      .set({ status: "completed", updatedAt: now })
      .where(eq(asyncJobs.id, jobId));
    // Enumeration is done; delivery may still be in flight.
    await checkCampaignCompletion(db, campaignId);
    return;
  }

  const recipients = page.map((m) => ({
    id: nanoid(),
    campaignId,
    contactId: m.contactId,
    email: m.email,
    status: "queued" as const,
    idempotencyKey: `${campaignId}:${m.contactId}`,
    outboxId: null,
    sentEmailId: null,
    attempts: 0,
    lastError: null,
    queuedAt: now,
    processedAt: null,
  }));

  // Conflict-ignored: a unique index alone does not make a replayed INSERT a
  // no-op, it makes the statement throw. Without this a replayed page fails
  // forever instead of being harmlessly redundant.
  //
  // Chunked because D1 caps bound variables per statement: a whole page in one
  // INSERT is 100 rows x 12 columns = 1200 variables, which fails outright with
  // "too many SQL variables". The page size stays 100 — it is the coordinator's
  // unit of work and the queue batch size, not a statement size.
  for (let i = 0; i < recipients.length; i += INSERT_CHUNK_ROWS) {
    await db
      .insert(campaignRecipients)
      .values(recipients.slice(i, i + INSERT_CHUNK_ROWS))
      .onConflictDoNothing({
        target: [campaignRecipients.campaignId, campaignRecipients.contactId],
      });
  }

  // Re-read: on a replay the ids above are fresh but the stored rows are the
  // originals, and the queue must reference the rows that actually exist.
  // Chunked for the same reason — one bound variable per id in the IN list.
  const stored: Array<{ id: string }> = [];
  for (let i = 0; i < page.length; i += SELECT_CHUNK_IDS) {
    const ids = page.slice(i, i + SELECT_CHUNK_IDS).map((m) => m.contactId);
    stored.push(
      ...(await db
        .select({ id: campaignRecipients.id })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.campaignId, campaignId),
            inArray(campaignRecipients.contactId, ids),
          ),
        )),
    );
  }

  await env.EMAIL_QUEUE.sendBatch(
    stored.map((r) => ({
      body: {
        type: "campaign_send",
        campaignId,
        campaignRecipientId: r.id,
      } satisfies CampaignSendMessage,
    })),
  );

  // Only now is it safe to move the cursor past this page.
  await db
    .update(asyncJobs)
    .set({
      cursor: page[page.length - 1]!.id,
      processedRows: job.processedRows + page.length,
      updatedAt: now,
    })
    .where(eq(asyncJobs.id, jobId));

  if (page.length < FAN_OUT_PAGE_SIZE) {
    await db
      .update(asyncJobs)
      .set({ status: "completed", updatedAt: now })
      .where(eq(asyncJobs.id, jobId));
    await checkCampaignCompletion(db, campaignId);
    return;
  }

  const next: CampaignFanOutMessage = {
    type: "campaign_fan_out",
    campaignId,
    jobId,
  };
  await env.EMAIL_QUEUE.send(next);
}

// --- Per-recipient send ---

/**
 * Claim a recipient for sending.
 *
 * One conditional UPDATE, never a read followed by a write: two duplicate queue
 * deliveries can both pass a read-then-check before either writes, and the
 * result is the same person receiving the campaign twice. Only the caller that
 * gets a row back may talk to the provider.
 *
 * `retryable_failed` is claimable because a manual retry re-enqueues those; the
 * same claim then covers both the original send and the retry.
 */
export async function claimRecipient(
  db: Db,
  campaignRecipientId: string,
): Promise<typeof campaignRecipients.$inferSelect | null> {
  const claimed = await db
    .update(campaignRecipients)
    .set({
      status: "processing",
      attempts: sql`${campaignRecipients.attempts} + 1`,
    })
    .where(
      and(
        eq(campaignRecipients.id, campaignRecipientId),
        sql`${campaignRecipients.status} IN ('queued', 'retrying', 'retryable_failed')`,
      ),
    )
    .returning();
  return claimed[0] ?? null;
}

/** Mint this recipient's per-list v2 unsubscribe URL. */
export async function buildV2UnsubscribeUrl(
  env: CloudflareBindings,
  opts: {
    campaignId: string;
    listId: string;
    contactId: string;
    email: string;
  },
): Promise<string> {
  const token = await signPayload(
    {
      v: 2,
      e: opts.email.toLowerCase(),
      l: opts.listId,
      c: opts.campaignId,
      k: opts.contactId,
    },
    env.UNSUBSCRIBE_SECRET,
    "unsubscribe",
  );
  return `${env.BASE_URL.replace(/\/+$/, "")}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Send one campaign email.
 *
 * Ordering matters throughout: claim, then send, then bookkeeping, and only
 * then release the outbox row. Every step is safe to repeat.
 */
export async function sendCampaignRecipient(
  db: Db,
  env: CloudflareBindings,
  sender: EmailSender,
  campaignRecipientId: string,
): Promise<"sent" | "suppressed" | "retrying" | "failed" | "skipped"> {
  const recipient = await claimRecipient(db, campaignRecipientId);
  // Another delivery of this message already claimed or terminalized it.
  if (!recipient) return "skipped";

  const campaignRows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, recipient.campaignId))
    .limit(1);
  const campaign = campaignRows[0];
  if (!campaign) throw new Error(`Campaign ${recipient.campaignId} not found`);

  const now = Math.floor(Date.now() / 1000);
  const sentEmailId = nanoid();

  const unsubscribeUrl = await buildV2UnsubscribeUrl(env, {
    campaignId: campaign.id,
    listId: campaign.listId,
    contactId: recipient.contactId,
    email: recipient.email,
  });

  const contactRows = await db
    .select({ name: contacts.name })
    .from(contacts)
    .where(eq(contacts.id, recipient.contactId))
    .limit(1);

  const vars: ReservedVars = {
    unsubscribe_url: unsubscribeUrl,
    subscriber_name: contactRows[0]?.name ?? "",
    subscriber_email: recipient.email,
  };

  // Rendered from the frozen snapshot, never the mutable template.
  const html = await applyRecipientTracking(
    env,
    interpolate(campaign.htmlSnapshot ?? "", vars),
    { campaignId: campaign.id, contactId: recipient.contactId },
  );
  const text = campaign.textSnapshot
    ? interpolate(campaign.textSnapshot, vars, { escape: false })
    : undefined;
  const subject = interpolate(
    campaign.subjectSnapshot ?? campaign.subject,
    vars,
    {
      escape: false,
    },
  );

  const fromAddress = campaign.fromAddressSnapshot ?? campaign.fromAddress;
  const messageId = generateMessageId(fromAddress);

  const result = await sendViaOutbox({
    db,
    env,
    sender,
    sentEmailId,
    campaignRecipientId,
    fromAddress,
    from: await formatFromAddress(db, fromAddress),
    to: recipient.email,
    subject,
    html,
    text,
    headers: { "Message-ID": messageId },
    transactional: false,
    unsubscribeContext: { url: unsubscribeUrl },
  });

  if (result.outcome === "suppressed") {
    await db
      .update(campaignRecipients)
      .set({ status: "suppressed", processedAt: now })
      .where(eq(campaignRecipients.id, campaignRecipientId));
    await checkCampaignCompletion(db, recipient.campaignId);
    return "suppressed";
  }

  if (result.outcome === "retrying") {
    await db
      .update(campaignRecipients)
      .set({
        status: "retrying",
        outboxId: result.outboxId,
        lastError: result.send.result?.error?.message ?? null,
      })
      .where(eq(campaignRecipients.id, campaignRecipientId));
    return "retrying";
  }

  if (result.outcome === "failed") {
    // The outbox already classified this: it only reaches "failed" for a
    // non-transient rejection, or once the transient budget is spent.
    const transient = result.send.result?.error?.transient === true;
    await db
      .update(campaignRecipients)
      .set({
        status: transient ? "retryable_failed" : "permanent_failed",
        outboxId: result.outboxId,
        lastError: result.send.result?.error?.message ?? null,
        processedAt: now,
      })
      .where(eq(campaignRecipients.id, campaignRecipientId));
    await checkCampaignCompletion(db, recipient.campaignId);
    return "failed";
  }

  await completeCampaignBookkeeping(db, {
    campaign,
    recipient,
    sentEmailId,
    outboxId: result.outboxId,
    messageId,
    subject,
    html: result.send.renderedHtml ?? html,
    text: result.send.renderedText ?? text ?? null,
    providerId: result.send.result?.id ?? null,
    now,
  });
  return "sent";
}

/**
 * Everything that must be true once the provider has accepted a message.
 *
 * Extracted so the reconciliation sweep can re-run exactly these steps against
 * an already-confirmed send, instead of calling the provider again.
 */
export async function completeCampaignBookkeeping(
  db: Db,
  opts: {
    campaign: typeof campaigns.$inferSelect;
    recipient: typeof campaignRecipients.$inferSelect;
    sentEmailId: string;
    outboxId: string;
    messageId: string | null;
    subject: string;
    html: string | null;
    text: string | null;
    providerId: string | null;
    now: number;
  },
): Promise<void> {
  const { campaign, recipient, sentEmailId, outboxId, now } = opts;

  // Link to an existing correspondent only — never create one. See Decision 23.
  const personId = await findPersonIdByEmail(db, recipient.email);
  if (personId) {
    await db
      .update(contacts)
      .set({ personId, updatedAt: now })
      .where(
        and(
          eq(contacts.id, recipient.contactId),
          sql`${contacts.personId} IS NULL`,
        ),
      );
  }

  await db
    .insert(sentEmails)
    .values({
      id: sentEmailId,
      personId,
      fromAddress: campaign.fromAddressSnapshot ?? campaign.fromAddress,
      toAddress: recipient.email,
      subject: opts.subject,
      bodyHtml: opts.html,
      bodyText: opts.text,
      inReplyTo: null,
      messageId: opts.messageId,
      resendId: opts.providerId,
      status: "sent",
      cc: null,
      // A blast is not correspondence: threading it would splice it into a real
      // conversation, and at list scale would manufacture thousands of them.
      conversationId: null,
      campaignId: campaign.id,
      sentAt: now,
      createdAt: now,
    })
    .onConflictDoNothing();

  await db
    .update(campaignRecipients)
    .set({
      status: "sent",
      sentEmailId,
      outboxId: null,
      processedAt: now,
    })
    .where(eq(campaignRecipients.id, recipient.id));

  // Only once all of the above committed is it safe to drop the held row.
  await finalizeOutboxRow(db, outboxId);

  await checkCampaignCompletion(db, campaign.id);
}

/**
 * Finish any send the provider accepted but whose bookkeeping did not commit.
 *
 * Never calls the provider — the message is already delivered, so re-sending
 * would duplicate it. This is the "reconcile, don't resend" half of the
 * `bookkeeping_pending` design.
 */
export async function reconcileCampaignBookkeeping(
  db: Db,
  env: CloudflareBindings,
): Promise<number> {
  const held = await db
    .select()
    .from(outboxEmails)
    .where(
      and(
        eq(outboxEmails.status, "bookkeeping_pending"),
        sql`${outboxEmails.campaignRecipientId} IS NOT NULL`,
      ),
    )
    .limit(200);

  let reconciled = 0;
  for (const row of held) {
    try {
      const recipients = await db
        .select()
        .from(campaignRecipients)
        .where(eq(campaignRecipients.id, row.campaignRecipientId!))
        .limit(1);
      const recipient = recipients[0];
      if (!recipient) {
        // Nothing left to reconcile against; drop the held row so it does not
        // accumulate forever.
        await finalizeOutboxRow(db, row.id);
        continue;
      }

      if (recipient.status === "sent") {
        await finalizeOutboxRow(db, row.id);
        reconciled++;
        continue;
      }

      const campaignRows = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, recipient.campaignId))
        .limit(1);
      const campaign = campaignRows[0];
      if (!campaign) {
        await finalizeOutboxRow(db, row.id);
        continue;
      }

      await completeCampaignBookkeeping(db, {
        campaign,
        recipient,
        sentEmailId: row.sentEmailId,
        outboxId: row.id,
        messageId: row.headers
          ? ((JSON.parse(row.headers) as Record<string, string>)[
              "Message-ID"
            ] ?? null)
          : null,
        subject: row.subject,
        html: row.bodyHtml,
        text: row.bodyText,
        providerId: null,
        now: Math.floor(Date.now() / 1000),
      });
      reconciled++;
    } catch (err) {
      console.error(`[campaign] reconcile failed for outbox ${row.id}:`, err);
    }
  }
  return reconciled;
}

// --- Completion ---

/**
 * Flip a campaign to its terminal status once every recipient is settled.
 *
 * Derived from a live terminal-state check, never from counters reaching
 * equality — a counter race would either strand a finished campaign in
 * `sending` or declare it done while sends are still in flight. The conditional
 * UPDATE means only one writer can win, so concurrent recipients finishing at
 * the same time cannot double-apply it.
 *
 * A campaign with any permanent rejection ends `completed_with_failures`, never
 * `sent`: labelling it "Sent" would hide that some subscribers never got it.
 */
export async function checkCampaignCompletion(
  db: Db,
  campaignId: string,
): Promise<void> {
  const jobDone = await db
    .select({ status: asyncJobs.status })
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "campaign_fan_out"),
        eq(asyncJobs.refId, campaignId),
      ),
    )
    .limit(1);
  // Enumeration still running: more recipients may yet be created.
  if (jobDone[0]?.status !== "completed") return;

  const outstanding = await db
    .select({ n: sql<number>`count(*)` })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        sql`${campaignRecipients.status} NOT IN ('sent', 'suppressed', 'permanent_failed')`,
      ),
    );
  if (Number(outstanding[0]?.n ?? 0) > 0) return;

  const permanent = await db
    .select({ n: sql<number>`count(*)` })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        eq(campaignRecipients.status, "permanent_failed"),
      ),
    );

  const now = Math.floor(Date.now() / 1000);
  const terminal =
    Number(permanent[0]?.n ?? 0) > 0 ? "completed_with_failures" : "sent";

  await db
    .update(campaigns)
    .set({ status: terminal, sentAt: now, updatedAt: now })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "sending")));
}

/** Refresh the advisory stats cache. Never read for a correctness decision. */
export async function refreshCampaignStats(
  db: Db,
  campaignId: string,
): Promise<void> {
  const rows = await db
    .select({ status: campaignRecipients.status, n: sql<number>`count(*)` })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .groupBy(campaignRecipients.status);

  // Unsubscribes live in their own ledger rather than the recipient rows, so
  // they need a second count. Both are `COUNT(*)` derivations: this cache is
  // only ever recomputed from the ledgers, never incremented in place, which
  // is why a replayed or crashed pass can't drift it.
  const unsubRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(campaignUnsubscribeAttributions)
    .where(eq(campaignUnsubscribeAttributions.campaignId, campaignId));

  const eventRows = await db
    .select({ eventType: campaignEvents.eventType, n: sql<number>`count(*)` })
    .from(campaignEvents)
    .where(eq(campaignEvents.campaignId, campaignId))
    .groupBy(campaignEvents.eventType);
  const events = (t: string) =>
    Number(eventRows.find((r) => r.eventType === t)?.n ?? 0);

  const by = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  await db
    .update(campaigns)
    .set({
      statsDelivered: by("sent"),
      statsSuppressed: by("suppressed"),
      statsRetryableFailed: by("retryable_failed"),
      statsPermanentFailed: by("permanent_failed"),
      statsUnsubscribes: Number(unsubRows[0]?.n ?? 0),
      statsUniqueOpeners: events("open"),
      statsUniqueClicks: events("click"),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(campaigns.id, campaignId));
}

/** Look up the list a campaign targets, for callers that need its settings. */
export async function campaignList(db: Db, campaignId: string) {
  const rows = await db
    .select({ list: lists })
    .from(campaigns)
    .innerJoin(lists, eq(lists.id, campaigns.listId))
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  return rows[0]?.list ?? null;
}
