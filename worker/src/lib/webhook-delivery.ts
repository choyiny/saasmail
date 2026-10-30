import { and, eq, gte, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { sentEmails } from "../db/sent-emails.schema";
import { webhookDeliveries } from "../db/webhook-deliveries.schema";
import { isDemoMode } from "./is-dev";
import { bracketedMessageId } from "./message-id";
import {
  auditAutoDisable,
  failureStatement,
  getWebhookConfig,
  successStatement,
  webhookWants,
  type OutboundWebhookEvent,
  type WebhookConfig,
} from "./webhook-config";
import { signWebhookBody } from "./webhook-signature";

const TIMEOUT_MS = 10_000;
const PREVIEW_LEN = 280;

export interface WebhookAttachment {
  filename: string;
  contentType: string;
  size: number;
}

export interface WebhookPayload {
  event: "message.received";
  id: string;
  receivedAt: number;
  inbox: string;
  from: { address: string; name: string | null };
  subject: string;
  textPreview: string;
  conversationId: string;
  attachments: WebhookAttachment[];
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  url: string;
}

/** Pure: assemble the webhook body from already-parsed email data. */
export function buildWebhookPayload(args: {
  emailId: string;
  receivedAt: number;
  inbox: string;
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  bodyText: string | null;
  conversationId: string;
  attachments: WebhookAttachment[];
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  baseUrl: string;
}): WebhookPayload {
  return {
    event: "message.received",
    id: args.emailId,
    receivedAt: args.receivedAt,
    inbox: args.inbox,
    from: { address: args.fromAddress, name: args.fromName },
    subject: args.subject ?? "",
    textPreview: (args.bodyText ?? "").slice(0, PREVIEW_LEN),
    conversationId: args.conversationId,
    attachments: args.attachments,
    auth: args.auth,
    url: `${args.baseUrl.replace(/\/$/, "")}/m/${encodeURIComponent(args.emailId)}`,
  };
}

/**
 * An outbound event (docs/webhooks.md): about a message sent from here. It
 * carries addresses and the subject, never any body text.
 */
export interface OutboundWebhookPayload {
  event: OutboundWebhookEvent;
  /** Stable across retries, also sent as `X-SaaSMail-Delivery`. */
  deliveryId: string;
  /** Unix seconds. */
  occurredAt: number;
  message: OutboundWebhookMessage;
  /** Absent on `message.sent`. */
  delivery?: OutboundWebhookDelivery;
}

export interface OutboundWebhookMessage {
  /** `sent_emails.id`: the `id` the send answered with. */
  id: string;
  messageId: string | null;
  from: string;
  /** To and Cc, never Bcc. */
  recipients: string[];
  subject: string;
  campaignId: string | null;
  sequenceId: string | null;
  sequenceEnrollmentId: string | null;
  conversationId: string | null;
  url: string;
}

export interface OutboundWebhookDelivery {
  /** Null when the whole message failed. */
  recipient: string | null;
  status: "bounced" | "complained" | "failed" | "rejected";
  bounceType: "hard" | "soft" | null;
  smtpStatus: string | null;
  enhancedStatus: string | null;
  /** At most 200 characters. */
  reason: string | null;
  provider: string | null;
}

type WebhookTarget = Pick<WebhookConfig, "url" | "secret">;
type WebhookResult = { ok: boolean; status?: number; error?: string };

/**
 * Awaitable single POST. Never throws; returns a delivery result.
 * `fetchImpl` is injectable so tests don't have to mutate the global `fetch`
 * (which leaks across the parallel vitest-pool-workers isolates).
 */
export async function sendWebhook(
  config: WebhookTarget,
  payload: WebhookPayload | OutboundWebhookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookResult> {
  return postWebhook(
    config,
    JSON.stringify(payload),
    payload.event,
    "deliveryId" in payload ? payload.deliveryId : null,
    fetchImpl,
  );
}

/** One signed POST of an already serialized body. Never throws. */
async function postWebhook(
  config: WebhookTarget,
  body: string,
  event: string,
  deliveryId: string | null,
  fetchImpl: typeof fetch,
): Promise<WebhookResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "SaaSMail-Webhook/1",
    "X-SaaSMail-Event": event,
  };
  if (deliveryId) headers["X-SaaSMail-Delivery"] = deliveryId;
  if (config.secret) {
    headers["X-SaaSMail-Signature"] = await signWebhookBody(
      body,
      config.secret,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget delivery off the ingest path. No-op when unconfigured. */
export function deliverWebhook(
  db: DrizzleD1Database<any>,
  ctx: ExecutionContext,
  payload: WebhookPayload,
): void {
  ctx.waitUntil(
    (async () => {
      try {
        const config = await getWebhookConfig(db);
        if (!config || !webhookWants(config, "message.received")) return;
        const result = await sendWebhook(config, payload);
        if (!result.ok) {
          console.warn(
            `Webhook delivery failed: ${result.status ?? result.error}`,
          );
        }
      } catch (err) {
        console.warn("Webhook delivery error:", err);
      }
    })(),
  );
}

// --- Outbound events: recorded in `webhook_deliveries`, sent from EMAIL_QUEUE.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** The queue pointer; the body lives in the row. */
export type WebhookDeliveryMessage = {
  type: "webhook_delivery";
  deliveryId: string;
};

/** The first try plus three retries: `max_retries` is 3, no dead-letter queue. */
export const WEBHOOK_MAX_ATTEMPTS = 4;
/** Seconds before the 2nd, 3rd and 4th attempt. */
export const WEBHOOK_RETRY_DELAYS = [60, 300, 1800];
/** A pending row this far past due has lost its queue message. */
const SWEEP_OVERDUE_SECONDS = 3600;
const SWEEP_LIMIT = 100;
const RETENTION_SECONDS = 7 * 24 * 60 * 60;
const PRUNE_BATCH = 1000;
const PRUNE_MAX_BATCHES = 10;
const TEXT_LIMIT = 200;

/** An outbound payload before it is given its delivery id. */
export type OutboundWebhookInput = Omit<OutboundWebhookPayload, "deliveryId">;

function cut(value: string | null | undefined): string | null {
  return value ? value.slice(0, TEXT_LIMIT) : null;
}

function messageUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/$/, "")}/m/${encodeURIComponent(id)}`;
}

/** To, more To and Cc, each address once; never Bcc. */
export function webhookRecipients(
  to: string,
  more: ({ email: string } | string)[][],
  except: string[] = [],
): string[] {
  const skip = new Set(except.map((address) => address.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [to, ...more.flat()]) {
    const address = (typeof entry === "string" ? entry : entry.email)
      .trim()
      .toLowerCase();
    if (!address || skip.has(address) || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

function parseAddressList(value: string | null): { email: string }[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is { email: string } =>
            typeof entry?.email === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * The `message` object of a sent row, and its Bcc addresses (trimmed, lower
 * case, never in the payload), or null when the row does not exist.
 */
export async function webhookMessageOf(
  db: Db,
  sentEmailId: string,
  baseUrl: string,
): Promise<{ message: OutboundWebhookMessage; bcc: string[] } | null> {
  const [row] = await db
    .select({
      fromAddress: sentEmails.fromAddress,
      toAddress: sentEmails.toAddress,
      additionalTo: sentEmails.additionalTo,
      cc: sentEmails.cc,
      bcc: sentEmails.bcc,
      subject: sentEmails.subject,
      messageId: sentEmails.messageId,
      campaignId: sentEmails.campaignId,
      sequenceId: sentEmails.sequenceId,
      sequenceEnrollmentId: sentEmails.sequenceEnrollmentId,
      conversationId: sentEmails.conversationId,
    })
    .from(sentEmails)
    .where(eq(sentEmails.id, sentEmailId))
    .limit(1);
  if (!row) return null;
  return {
    message: {
      id: sentEmailId,
      messageId: row.messageId,
      from: row.fromAddress,
      recipients: webhookRecipients(row.toAddress, [
        parseAddressList(row.additionalTo),
        parseAddressList(row.cc),
      ]),
      subject: row.subject,
      campaignId: row.campaignId,
      sequenceId: row.sequenceId,
      sequenceEnrollmentId: row.sequenceEnrollmentId,
      conversationId: row.conversationId,
      url: messageUrl(baseUrl, sentEmailId),
    },
    bcc: parseAddressList(row.bcc).map((entry) =>
      entry.email.trim().toLowerCase(),
    ),
  };
}

/**
 * The guarded insert of a `pending` delivery, for the caller to run or add to
 * its batch (so the row commits with its source event or not at all). Null
 * when the event is not wanted, or in demo mode. A repeated `sourceKey`
 * inserts nothing; the statement returns the inserted id.
 */
export function webhookIntent(
  env: CloudflareBindings,
  db: Db,
  config: WebhookConfig | null,
  input: OutboundWebhookInput,
  sourceKey: string,
  opts: { guard?: SQL; frozen?: boolean; now?: number } = {},
) {
  if (isDemoMode(env) || !config || !webhookWants(config, input.event)) {
    return null;
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const deliveryId = `wd_${nanoid()}`;
  const payload: OutboundWebhookPayload = {
    event: input.event,
    deliveryId,
    occurredAt: input.occurredAt,
    message: input.message,
    ...(input.delivery ? { delivery: input.delivery } : {}),
  };
  // Every column, in the schema's order.
  const statement = db
    .insert(webhookDeliveries)
    .select(
      sql`SELECT ${deliveryId}, ${sourceKey}, ${input.event}, ${input.message.id}, ${config.generation},
                 ${JSON.stringify(payload)}, ${opts.frozen ? 1 : 0}, 'pending', 0, NULL, NULL, NULL, ${now}, ${now}, NULL
           WHERE ${opts.guard ?? sql`1`}`,
    )
    .onConflictDoNothing({ target: webhookDeliveries.sourceKey })
    .returning({ id: webhookDeliveries.id });
  return { deliveryId, statement };
}

/**
 * Queue the pointer. A failure is only logged: the hourly sweep resends a
 * pending row that is overdue.
 */
export async function dispatchWebhook(
  env: CloudflareBindings,
  deliveryId: string,
  opts: { delaySeconds?: number } = {},
): Promise<void> {
  try {
    const message: WebhookDeliveryMessage = {
      type: "webhook_delivery",
      deliveryId,
    };
    await env.EMAIL_QUEUE.send(
      message,
      opts.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined,
    );
  } catch (err) {
    console.error(`[webhook] delivery ${deliveryId} not queued:`, err);
  }
}

/** Record and queue one outbound event outside a batch. Never throws. */
export async function recordWebhook(
  env: CloudflareBindings,
  db: Db,
  config: WebhookConfig | null,
  input: OutboundWebhookInput,
  sourceKey: string,
  opts: { frozen?: boolean } = {},
): Promise<void> {
  try {
    const intent = webhookIntent(env, db, config, input, sourceKey, opts);
    if (!intent) return;
    const inserted = await intent.statement;
    if (inserted.length > 0) await dispatchWebhook(env, intent.deliveryId);
  } catch (err) {
    console.error(`[webhook] ${input.event} not recorded:`, err);
  }
}

/**
 * `message.sent` or `message.failed` for a send, after its own bookkeeping.
 * Never throws, so a webhook error never changes a send's result. The
 * campaign, sequence and conversation ids are added from the sent row when
 * the delivery runs (the caller may write that row after this).
 */
export async function recordSendWebhook(
  env: CloudflareBindings,
  db: Db,
  args: {
    event: "message.sent" | "message.failed";
    sentEmailId: string;
    /** As submitted or as the provider delivered it, bracketed or not. */
    messageId?: string | null;
    from: string;
    to: string;
    additionalTo?: { email: string }[];
    cc?: { email: string }[];
    /** Left out of the recipients: the suppressed ones. */
    except?: string[];
    subject: string;
    /** For `message.failed`. */
    reason?: string | null;
    provider?: string | null;
  },
): Promise<void> {
  try {
    const config = await getWebhookConfig(db);
    if (!webhookWants(config, args.event)) return;
    await recordWebhook(
      env,
      db,
      config,
      {
        event: args.event,
        occurredAt: Math.floor(Date.now() / 1000),
        message: {
          id: args.sentEmailId,
          messageId: args.messageId?.trim()
            ? bracketedMessageId(args.messageId)
            : null,
          from: args.from,
          recipients: webhookRecipients(
            args.to,
            [args.additionalTo ?? [], args.cc ?? []],
            args.except,
          ),
          subject: args.subject,
          campaignId: null,
          sequenceId: null,
          sequenceEnrollmentId: null,
          conversationId: null,
          url: messageUrl(env.BASE_URL, args.sentEmailId),
        },
        ...(args.event === "message.failed"
          ? {
              delivery: {
                recipient: null,
                status: "failed" as const,
                bounceType: null,
                smtpStatus: null,
                enhancedStatus: null,
                reason: cut(args.reason),
                provider: args.provider ?? null,
              },
            }
          : {}),
      },
      `sent:${args.sentEmailId}:${args.event}`,
    );
  } catch (err) {
    console.error(`[webhook] ${args.event} not recorded:`, err);
  }
}

/** The payload's final form: a send event takes its ids from the sent row. */
async function freezePayload(
  db: Db,
  row: { sourceKey: string; messageId: string; payload: string },
): Promise<string> {
  if (!row.sourceKey.startsWith("sent:")) return row.payload;
  const payload = JSON.parse(row.payload) as OutboundWebhookPayload;
  const [sent] = await db
    .select({
      messageId: sentEmails.messageId,
      campaignId: sentEmails.campaignId,
      sequenceId: sentEmails.sequenceId,
      sequenceEnrollmentId: sentEmails.sequenceEnrollmentId,
      conversationId: sentEmails.conversationId,
    })
    .from(sentEmails)
    .where(eq(sentEmails.id, row.messageId))
    .limit(1);
  if (!sent) return row.payload;
  payload.message = {
    ...payload.message,
    messageId: sent.messageId ?? payload.message.messageId,
    campaignId: sent.campaignId,
    sequenceId: sent.sequenceId,
    sequenceEnrollmentId: sent.sequenceEnrollmentId,
    conversationId: sent.conversationId,
  };
  return JSON.stringify(payload);
}

/** One consumer holds an attempt this long: well past the POST's timeout. */
const CLAIM_SECONDS = 120;
/** A send event waits this long for its sent row, then goes without its ids. */
const SENT_ROW_WAIT_SECONDS = 300;
const SENT_ROW_RECHECK_SECONDS = 30;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** No consumer holds the row's attempt. */
function unclaimed(now: number): SQL {
  return or(
    isNull(webhookDeliveries.claimedUntil),
    lt(webhookDeliveries.claimedUntil, now),
  )!;
}

/** Held by the claim that set `claimedUntil` to this value. */
function heldBy(claim: number): SQL {
  return eq(webhookDeliveries.claimedUntil, claim);
}

/** Every attempt used and none in flight: left only to be finished. */
function spent(now: number): SQL {
  return and(
    gte(webhookDeliveries.attempts, WEBHOOK_MAX_ATTEMPTS),
    unclaimed(now),
  )!;
}

/**
 * Marks one finish in `claimed_until`: negative, so never a live claim (a
 * claim is a future Unix time), and random, so no other finish of the row
 * carries it.
 */
function finishMarker(): number {
  return -1 - Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/**
 * Finish a pending row under `guard`; `finished` is true when this call did
 * it. `then` builds a statement that runs in the same D1 batch (one
 * transaction), given the condition that holds only when this call's
 * transition happened; `followUp` is its result.
 */
async function finishDelivery(
  db: Db,
  id: string,
  status: "delivered" | "failed" | "cancelled",
  guard: SQL,
  fields: { lastStatus?: number | null; lastError?: string | null } = {},
  now: number = nowSeconds(),
  then?: (finished: SQL) => BatchItem<"sqlite">,
): Promise<{ finished: boolean; followUp: unknown }> {
  const marker = finishMarker();
  const update = db
    .update(webhookDeliveries)
    .set({
      status,
      payload: null,
      claimedUntil: marker,
      finishedAt: now,
      ...fields,
    })
    .where(
      and(
        eq(webhookDeliveries.id, id),
        eq(webhookDeliveries.status, "pending"),
        guard,
      ),
    )
    .returning({ id: webhookDeliveries.id });
  if (!then) {
    return { finished: (await update).length > 0, followUp: null };
  }
  const finished = sql`EXISTS (SELECT 1 FROM webhook_deliveries AS wd
                               WHERE wd.id = ${id} AND wd.status = ${status}
                                 AND wd.claimed_until = ${marker})`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [rows, followUp] = (await db.batch([
    update,
    then(finished),
  ] as any)) as [unknown[], unknown];
  return { finished: rows.length > 0, followUp };
}

/**
 * A final failure, counted toward the pause in the same transaction when
 * this call made it: a D1 error leaves both undone (the row stays pending).
 */
async function failDelivery(
  db: Db,
  row: { id: string; generation: number },
  guard: SQL,
  fields: { lastStatus: number | null; lastError: string | null },
  now: number = nowSeconds(),
): Promise<boolean> {
  const { finished, followUp } = await finishDelivery(
    db,
    row.id,
    "failed",
    guard,
    fields,
    now,
    (done) =>
      failureStatement(
        db,
        row.generation,
        { status: fields.lastStatus, error: fields.lastError },
        now,
        done,
      ),
  );
  if (!finished) return false;
  await auditAutoDisable(
    db,
    row.generation,
    followUp as { disabledAt: number | null; reason: string | null }[],
  ).catch((err) => console.error(`[webhook] pause not audited:`, err));
  return true;
}

async function sentRowExists(db: Db, sentEmailId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sentEmails.id })
    .from(sentEmails)
    .where(eq(sentEmails.id, sentEmailId))
    .limit(1);
  return Boolean(row);
}

function retryable(result: WebhookResult): boolean {
  if (result.status === undefined) return true; // network error or timeout
  return result.status === 408 || result.status === 429 || result.status >= 500;
}

/**
 * One `webhook_delivery` queue message. Acks or retries the message itself
 * and never throws. Each attempt is claimed on the row first, so two
 * consumers of the same delivery never POST at once, and the row (not
 * `msg.attempts`) counts the attempts.
 */
export async function runWebhookDelivery(
  db: Db,
  env: CloudflareBindings,
  msg: Pick<Message<unknown>, "body" | "attempts" | "ack" | "retry">,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const deliveryId = (msg.body as WebhookDeliveryMessage).deliveryId;
  let claim: number | null = null;
  let attempt = 0;
  let generation = 0;
  try {
    const [current] = await db
      .select({
        status: webhookDeliveries.status,
        sourceKey: webhookDeliveries.sourceKey,
        messageId: webhookDeliveries.messageId,
        frozen: webhookDeliveries.frozen,
        generation: webhookDeliveries.generation,
        lastStatus: webhookDeliveries.lastStatus,
        lastError: webhookDeliveries.lastError,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    // Finished already (a redelivered message): nothing is sent twice.
    if (!current || current.status !== "pending") {
      msg.ack();
      return;
    }
    const now = nowSeconds();

    // A send's caller writes its sent row after the event is recorded: wait
    // for it (no POST, no attempt used) so the ids can be frozen in.
    if (
      !current.frozen &&
      current.sourceKey.startsWith("sent:") &&
      now - current.createdAt < SENT_ROW_WAIT_SECONDS &&
      !(await sentRowExists(db, current.messageId))
    ) {
      await dispatchWebhook(env, deliveryId, {
        delaySeconds: SENT_ROW_RECHECK_SECONDS,
      });
      msg.ack();
      return;
    }

    const until = now + CLAIM_SECONDS;
    const [row] = await db
      .update(webhookDeliveries)
      .set({
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        claimedUntil: until,
      })
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.status, "pending"),
          lt(webhookDeliveries.attempts, WEBHOOK_MAX_ATTEMPTS),
          unclaimed(now),
        ),
      )
      .returning();
    if (!row) {
      // Finished meanwhile, attempts spent (finish it), or another consumer
      // holds the attempt (the sweep is the backstop).
      await failDelivery(
        db,
        { id: deliveryId, generation: current.generation },
        spent(now),
        { lastStatus: current.lastStatus, lastError: current.lastError },
        now,
      );
      msg.ack();
      return;
    }
    claim = until;
    attempt = row.attempts;
    generation = row.generation;
    const held = heldBy(until);

    const config = await getWebhookConfig(db);
    if (
      !config ||
      !webhookWants(config, row.event as OutboundWebhookEvent) ||
      config.generation !== row.generation
    ) {
      // Unticked, paused, or saved since (the URL or secret may differ).
      await finishDelivery(db, row.id, "cancelled", held);
      msg.ack();
      return;
    }

    let body = row.payload;
    if (body === null) {
      await failDelivery(db, row, held, {
        lastStatus: null,
        lastError: "no payload",
      });
      msg.ack();
      return;
    }
    if (!row.frozen) {
      // Frozen before the first POST: every attempt sends exactly this body.
      body = await freezePayload(db, { ...row, payload: body });
      const stored = await db
        .update(webhookDeliveries)
        .set({ payload: body, frozen: 1 })
        .where(
          and(
            eq(webhookDeliveries.id, row.id),
            eq(webhookDeliveries.status, "pending"),
            eq(webhookDeliveries.frozen, 0),
            held,
          ),
        )
        .returning({ id: webhookDeliveries.id });
      if (stored.length === 0) {
        msg.ack();
        return;
      }
    }

    const result = await postWebhook(
      config,
      body,
      row.event,
      row.id,
      opts.fetchImpl ?? fetch,
    );
    const fields = {
      lastStatus: result.status ?? null,
      lastError: cut(result.error),
    };
    if (result.ok) {
      await finishDelivery(
        db,
        row.id,
        "delivered",
        held,
        fields,
        undefined,
        (done) => successStatement(db, row.generation, done),
      );
      msg.ack();
      return;
    }
    if (retryable(result) && attempt < WEBHOOK_MAX_ATTEMPTS) {
      const delaySeconds = WEBHOOK_RETRY_DELAYS[attempt - 1];
      await db
        .update(webhookDeliveries)
        .set({
          ...fields,
          nextAttemptAt: nowSeconds() + delaySeconds,
          claimedUntil: null,
        })
        .where(
          and(
            eq(webhookDeliveries.id, row.id),
            eq(webhookDeliveries.status, "pending"),
            held,
          ),
        );
      msg.retry({ delaySeconds });
      return;
    }
    await failDelivery(db, row, held, fields);
    msg.ack();
  } catch (err) {
    console.error(`[webhook] delivery ${deliveryId} failed:`, err);
    if (claim === null) {
      // No attempt was used: try again, or leave the row to the sweep.
      if (msg.attempts < WEBHOOK_MAX_ATTEMPTS) {
        msg.retry({ delaySeconds: WEBHOOK_RETRY_DELAYS[msg.attempts - 1] });
      } else {
        msg.ack();
      }
      return;
    }
    if (attempt < WEBHOOK_MAX_ATTEMPTS) {
      const delaySeconds = WEBHOOK_RETRY_DELAYS[attempt - 1];
      // Free the attempt for the retry; if that fails too, the claim expires.
      await db
        .update(webhookDeliveries)
        .set({ claimedUntil: null, nextAttemptAt: nowSeconds() + delaySeconds })
        .where(
          and(
            eq(webhookDeliveries.id, deliveryId),
            eq(webhookDeliveries.status, "pending"),
            heldBy(claim),
          ),
        )
        .catch((error) =>
          console.error(`[webhook] delivery ${deliveryId} not freed:`, error),
        );
      msg.retry({ delaySeconds });
      return;
    }
    // The last attempt: finish the row, or leave it to the sweep.
    await failDelivery(db, { id: deliveryId, generation }, heldBy(claim), {
      lastStatus: null,
      lastError: cut(String(err)),
    }).catch((error) =>
      console.error(`[webhook] delivery ${deliveryId} not finished:`, error),
    );
    msg.ack();
  }
}

/**
 * Hourly: resend the queue pointer of a pending row whose message was lost,
 * finish one whose attempts are spent (once no attempt is in flight), then
 * delete rows finished more than 7 days ago.
 */
export async function sweepWebhookDeliveries(
  env: CloudflareBindings,
  db: Db,
  now: number,
): Promise<{ resent: number; failed: number; pruned: number }> {
  const counts = { resent: 0, failed: 0, pruned: 0 };
  // Demo mode queues nothing (the consumer drops every message).
  if (isDemoMode(env)) return counts;
  const overdue = await db
    .select({
      id: webhookDeliveries.id,
      generation: webhookDeliveries.generation,
      attempts: webhookDeliveries.attempts,
      lastStatus: webhookDeliveries.lastStatus,
      lastError: webhookDeliveries.lastError,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lt(webhookDeliveries.nextAttemptAt, now - SWEEP_OVERDUE_SECONDS),
        unclaimed(now),
      ),
    )
    .orderBy(webhookDeliveries.nextAttemptAt)
    .limit(SWEEP_LIMIT);
  for (const row of overdue) {
    if (row.attempts >= WEBHOOK_MAX_ATTEMPTS) {
      // A D1 error leaves the row pending for the next sweep.
      const failed = await failDelivery(
        db,
        row,
        spent(now),
        { lastStatus: row.lastStatus, lastError: row.lastError },
        now,
      ).catch((err) => {
        console.error(`[webhook] delivery ${row.id} not finished:`, err);
        return false;
      });
      if (failed) counts.failed += 1;
      continue;
    }
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: now })
      .where(
        and(
          eq(webhookDeliveries.id, row.id),
          eq(webhookDeliveries.status, "pending"),
        ),
      );
    await dispatchWebhook(env, row.id);
    counts.resent += 1;
  }

  const cutoff = now - RETENTION_SECONDS;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const result = await db.run(sql`
      DELETE FROM webhook_deliveries
      WHERE rowid IN (
        SELECT rowid FROM webhook_deliveries
        WHERE finished_at < ${cutoff}
        ORDER BY finished_at
        LIMIT ${PRUNE_BATCH}
      )
    `);
    const changes = result.meta?.changes ?? 0;
    counts.pruned += changes;
    if (changes < PRUNE_BATCH) break;
  }
  return counts;
}
