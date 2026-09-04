import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { asyncJobs } from "../db/async-jobs.schema";
import { campaigns } from "../db/campaigns.schema";
import { campaignRecipients } from "../db/campaign-recipients.schema";
import { campaignUnsubscribeAttributions } from "../db/campaign-unsubscribe-attributions.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { json200Response, json201Response } from "../lib/helpers";
import {
  assertInboxAllowed,
  inboxFilter,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import {
  buildV2UnsubscribeUrl,
  snapshotCampaign,
  type CampaignFanOutMessage,
  type CampaignSendMessage,
} from "../lib/campaign-sender";
import { canPerform, type CampaignAction } from "../lib/campaign-states";
import { createEmailSender } from "../lib/email-sender";
import { formatFromAddress } from "../lib/format-from-address";
import { interpolate } from "../lib/interpolate";
import { sendWithSuppressionCheck } from "../lib/send";
import { MAX_LIST_MEMBERS } from "./lists-router";
import type { Variables } from "../variables";

export const campaignsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const CampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  subject: z.string(),
  templateSlug: z.string(),
  fromAddress: z.string(),
  listId: z.string(),
  status: z.string(),
  scheduledAt: z.number().nullable(),
  sentAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const StatsSchema = z.object({
  targeted: z.number(),
  delivered: z.number(),
  suppressed: z.number(),
  retryableFailed: z.number(),
  permanentFailed: z.number(),
  unsubscribes: z.number(),
});

const CampaignDetailSchema = CampaignSchema.extend({ stats: StatsSchema });

const CreateCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  templateSlug: z.string().min(1).max(200),
  listId: z.string().min(1),
});

const UpdateCampaignSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  subject: z.string().min(1).max(500).optional(),
  templateSlug: z.string().min(1).max(200).optional(),
  listId: z.string().min(1).optional(),
  textBodyOverride: z.string().max(100_000).nullable().optional(),
});

const ErrorSchema = z.object({ error: z.string() });

function now() {
  return Math.floor(Date.now() / 1000);
}

function serialize(row: typeof campaigns.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    templateSlug: row.templateSlug,
    fromAddress: row.fromAddress,
    listId: row.listId,
    status: row.status,
    scheduledAt: row.scheduledAt,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadForCaller(
  db: Variables["db"],
  allowed: AllowedInboxes,
  id: string,
) {
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Same rule as lists: 403 for out-of-scope, 404 for absent, so a scoped
  // member cannot probe for other teams' campaigns.
  assertInboxAllowed(allowed, row.fromAddress);
  return row;
}

/** Reject an action the state machine does not permit, with a useful message. */
function transitionError(action: CampaignAction, status: string) {
  return {
    error: `Cannot ${action.replace("_", "-")} a campaign in status "${status}"`,
  };
}

/**
 * Live-computed stats.
 *
 * Read from the ledgers rather than the cached `stats*` columns, which are
 * advisory and may lag the hourly rollup. `statsTargeted` is the one exception:
 * it is written once at fan-out start and is authoritative.
 */
async function liveStats(
  db: Variables["db"],
  campaign: typeof campaigns.$inferSelect,
) {
  const byStatus = await db
    .select({ status: campaignRecipients.status, n: sql<number>`count(*)` })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaign.id))
    .groupBy(campaignRecipients.status);
  const count = (s: string) =>
    Number(byStatus.find((r) => r.status === s)?.n ?? 0);

  const unsub = await db
    .select({ n: sql<number>`count(*)` })
    .from(campaignUnsubscribeAttributions)
    .where(eq(campaignUnsubscribeAttributions.campaignId, campaign.id));

  return {
    targeted: campaign.statsTargeted,
    delivered: count("sent"),
    suppressed: count("suppressed"),
    retryableFailed: count("retryable_failed"),
    permanentFailed: count("permanent_failed"),
    unsubscribes: Number(unsub[0]?.n ?? 0),
  };
}

// --- GET / ---

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Campaigns"],
  description: "List campaigns, newest first.",
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        items: z.array(CampaignSchema),
        nextCursor: z.string().nullable(),
      }),
      "Campaigns",
    ),
  },
});

campaignsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { cursor, limit: limitRaw } = c.req.valid("query");
  const limit = Math.min(
    Number.parseInt(limitRaw ?? "", 10) || DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  const conditions = [inboxFilter(allowed, campaigns.fromAddress)];
  if (cursor) {
    conditions.push(lt(campaigns.createdAt, Number.parseInt(cursor, 10)));
  }

  const rows = await db
    .select()
    .from(campaigns)
    .where(and(...conditions.filter(Boolean)))
    .orderBy(desc(campaigns.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return c.json({
    items: page.map(serialize),
    nextCursor:
      rows.length > limit ? String(page[page.length - 1]!.createdAt) : null,
  });
});

// --- POST / ---

const createCampaignRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Campaigns"],
  description:
    "Create a draft campaign. The sending identity is inherited from the list, so a campaign can never be sent from an identity the list does not use.",
  request: {
    body: {
      content: { "application/json": { schema: CreateCampaignSchema } },
      required: true,
    },
  },
  responses: {
    ...json201Response(CampaignSchema, "Created campaign"),
    404: {
      description: "List not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

campaignsRouter.openapi(createCampaignRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const body = c.req.valid("json");

  const listRows = await db
    .select()
    .from(lists)
    .where(eq(lists.id, body.listId))
    .limit(1);
  const list = listRows[0];
  if (!list) return c.json({ error: "List not found" }, 404);
  if (list.archivedAt !== null) {
    return c.json({ error: "List is archived" }, 409);
  }
  assertInboxAllowed(allowed, list.fromAddress);

  const ts = now();
  const row = {
    id: nanoid(),
    name: body.name,
    subject: body.subject,
    templateSlug: body.templateSlug,
    fromAddress: list.fromAddress,
    listId: list.id,
    status: "draft" as const,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(campaigns).values(row);
  return c.json(serialize(row as typeof campaigns.$inferSelect), 201);
});

// --- GET /:id ---

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Campaigns"],
  description:
    "Campaign detail with live stats, computed from the recipient and attribution ledgers rather than the advisory cache.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(CampaignDetailSchema, "Campaign"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

campaignsRouter.openapi(getRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const campaign = await loadForCaller(db, c.get("allowedInboxes")!, id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  return c.json({
    ...serialize(campaign),
    stats: await liveStats(db, campaign),
  });
});

// --- PATCH /:id ---

const updateRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Campaigns"],
  description:
    "Edit a draft. Only drafts are editable: once a campaign leaves draft its content is snapshotted, and editing afterwards would mean two different emails going out under one name.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: UpdateCampaignSchema } },
      required: true,
    },
  },
  responses: {
    ...json200Response(CampaignSchema, "Updated campaign"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Not editable in this state",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

campaignsRouter.openapi(updateRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const campaign = await loadForCaller(db, c.get("allowedInboxes")!, id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (!canPerform("edit", campaign.status)) {
    return c.json(transitionError("edit", campaign.status), 409);
  }

  const patch: Partial<typeof campaigns.$inferInsert> = { updatedAt: now() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.subject !== undefined) patch.subject = body.subject;
  if (body.templateSlug !== undefined) patch.templateSlug = body.templateSlug;
  if (body.textBodyOverride !== undefined) {
    patch.textBodyOverride = body.textBodyOverride;
  }
  if (body.listId !== undefined && body.listId !== campaign.listId) {
    const listRows = await db
      .select()
      .from(lists)
      .where(eq(lists.id, body.listId))
      .limit(1);
    if (!listRows[0]) return c.json({ error: "List not found" }, 404);
    assertInboxAllowed(c.get("allowedInboxes")!, listRows[0].fromAddress);
    patch.listId = body.listId;
    // The identity follows the list, so the two can never disagree.
    patch.fromAddress = listRows[0].fromAddress;
  }

  await db.update(campaigns).set(patch).where(eq(campaigns.id, id));
  const updated = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .limit(1);
  return c.json(serialize(updated[0]!));
});

// --- DELETE /:id ---

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Campaigns"],
  description:
    "Delete a draft. A campaign that has sent anything is never deleted — its recipient ledger is the record of who received what.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ deleted: z.literal(true) }), "Deleted"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Not deletable in this state",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

campaignsRouter.openapi(deleteRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const campaign = await loadForCaller(db, c.get("allowedInboxes")!, id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (!canPerform("delete", campaign.status)) {
    return c.json(transitionError("delete", campaign.status), 409);
  }
  await db.delete(campaigns).where(eq(campaigns.id, id));
  return c.json({ deleted: true as const });
});

// --- Shared start-sending path ---

/**
 * Snapshot the content, create the fan-out job and enqueue the coordinator.
 *
 * Shared by `POST /send` and the cron's scheduled trigger so both take exactly
 * the same path — a scheduled send that behaved differently from a manual one
 * would be a bug waiting to happen.
 */
/** `null` when sending started; otherwise why it could not. */
export type BeginSendFailure = { status: 404 | 409 | 422; error: string };

export async function beginCampaignSend(
  db: Variables["db"],
  env: CloudflareBindings,
  campaignId: string,
): Promise<BeginSendFailure | null> {
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  const campaign = rows[0];
  if (!campaign) return { status: 404, error: "Campaign not found" };
  if (!canPerform("send", campaign.status)) {
    return {
      status: 409,
      error: transitionError("send", campaign.status).error,
    };
  }

  const subscribed = await db
    .select({ n: sql<number>`count(*)` })
    .from(listMembers)
    .where(
      and(
        eq(listMembers.listId, campaign.listId),
        eq(listMembers.status, "subscribed"),
      ),
    );
  const target = Number(subscribed[0]?.n ?? 0);
  if (target === 0) {
    return { status: 422, error: "The list has no subscribers" };
  }
  if (target > MAX_LIST_MEMBERS) {
    return {
      status: 422,
      error: `The list exceeds the ${MAX_LIST_MEMBERS} member cap`,
    };
  }

  const capacity = await providerCapacityError(
    db,
    env,
    campaign.fromAddress,
    target,
  );
  if (capacity) return { status: 422, error: capacity };

  const ts = now();
  await db
    .update(campaigns)
    .set({ status: "preparing", updatedAt: ts })
    .where(eq(campaigns.id, campaignId));

  const snapshotError = await snapshotCampaign(db, campaignId, ts);
  if (snapshotError !== null) {
    // Put it back rather than stranding it in `preparing` with nothing to send.
    await db
      .update(campaigns)
      .set({ status: campaign.status, updatedAt: ts })
      .where(eq(campaigns.id, campaignId));
    return { status: 422, error: snapshotError };
  }

  const jobId = nanoid();
  await db.insert(asyncJobs).values({
    id: jobId,
    jobType: "campaign_fan_out",
    refId: campaignId,
    status: "running",
    cursor: null,
    createdAt: ts,
    updatedAt: ts,
  });
  await db
    .update(campaigns)
    .set({ fanOutJobId: jobId, updatedAt: ts })
    .where(eq(campaigns.id, campaignId));

  const message: CampaignFanOutMessage = {
    type: "campaign_fan_out",
    campaignId,
    jobId,
  };
  await env.EMAIL_QUEUE.send(message);
  return null;
}

/**
 * Optional provider preflight.
 *
 * Skipped entirely when `PROVIDER_DAILY_SEND_LIMIT` is unset, which is the
 * default — so this commits no operator to configuring anything. The day's
 * count is scoped to the sending identity: that uses the existing
 * `sent_emails_from_sent_idx` (there is no index on `sent_at` alone), and a
 * provider quota is per-domain anyway.
 */
async function providerCapacityError(
  db: Variables["db"],
  env: CloudflareBindings,
  fromAddress: string,
  target: number,
): Promise<string | null> {
  const raw = (env as Record<string, unknown>)["PROVIDER_DAILY_SEND_LIMIT"];
  if (raw === undefined || raw === null || raw === "") return null;
  const limit = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit <= 0) return null;

  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const sent = await db
    .select({ n: sql<number>`count(*)` })
    .from(sentEmails)
    .where(
      and(
        eq(sentEmails.fromAddress, fromAddress),
        sql`${sentEmails.sentAt} >= ${since}`,
      ),
    );
  const already = Number(sent[0]?.n ?? 0);
  if (already + target > limit) {
    return `This send would exceed the configured daily provider limit of ${limit}`;
  }
  return null;
}

// --- POST /:id/send ---

const sendRoute = createRoute({
  method: "post",
  path: "/{id}/send",
  tags: ["Campaigns"],
  description:
    "Start sending now. Also the explicit confirmation required to fire an `overdue` campaign.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ status: z.string() }), "Sending started"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Not sendable in this state",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Preflight failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

campaignsRouter.openapi(sendRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const campaign = await loadForCaller(db, c.get("allowedInboxes")!, id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const failure = await beginCampaignSend(db, c.env, id);
  if (failure !== null) {
    return c.json({ error: failure.error }, failure.status);
  }
  return c.json({ status: "preparing" });
});

// --- POST /:id/schedule ---

const scheduleRoute = createRoute({
  method: "post",
  path: "/{id}/schedule",
  tags: ["Campaigns"],
  description:
    "Schedule a send. Granularity is the hourly cron window, so a campaign scheduled for 12:01 goes out at the next tick — up to ~59 minutes later.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ scheduledAt: z.number().int().positive() }),
        },
      },
      required: true,
    },
  },
  responses: {
    ...json200Response(CampaignSchema, "Scheduled"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Not schedulable in this state",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Schedule is in the past",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

campaignsRouter.openapi(scheduleRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const { scheduledAt } = c.req.valid("json");
  const campaign = await loadForCaller(db, c.get("allowedInboxes")!, id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (!canPerform("schedule", campaign.status)) {
    return c.json(transitionError("schedule", campaign.status), 409);
  }
  if (scheduledAt <= now()) {
    // Silently sending immediately would surprise an operator who mistyped a
    // date; make them say so with /send.
    return c.json({ error: "scheduledAt must be in the future" }, 422);
  }

  await db
    .update(campaigns)
    .set({ status: "scheduled", scheduledAt, updatedAt: now() })
    .where(eq(campaigns.id, id));
  const updated = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .limit(1);
  return c.json(serialize(updated[0]!));
});

// --- POST /:id/cancel ---

const cancelRoute = createRoute({
  method: "post",
  path: "/{id}/cancel",
  tags: ["Campaigns"],
  description:
    "Cancel a campaign. Mail already accepted by the provider cannot be recalled; this stops further fan-out and sending.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(CampaignSchema, "Cancelled"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Not cancellable in this state",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

campaignsRouter.openapi(cancelRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const campaign = await loadForCaller(db, c.get("allowedInboxes")!, id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (!canPerform("cancel", campaign.status)) {
    return c.json(transitionError("cancel", campaign.status), 409);
  }

  const ts = now();
  await db
    .update(campaigns)
    .set({ status: "cancelled", updatedAt: ts })
    .where(eq(campaigns.id, id));
  // Stop the coordinator at its next cancellation check.
  await db
    .update(asyncJobs)
    .set({ status: "cancelled", updatedAt: ts })
    .where(
      and(
        eq(asyncJobs.jobType, "campaign_fan_out"),
        eq(asyncJobs.refId, id),
        eq(asyncJobs.status, "running"),
      ),
    );

  const updated = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .limit(1);
  return c.json(serialize(updated[0]!));
});

// --- POST /:id/retry ---

const retryRoute = createRoute({
  method: "post",
  path: "/{id}/retry",
  tags: ["Campaigns"],
  description:
    "Re-enqueue recoverable recipients. Only `queued`, `retrying` and `retryable_failed` rows are re-sent — `permanent_failed` and `unknown` are excluded and never resent, automatically or manually.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ requeued: z.number() }), "Retry started"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Not retryable in this state",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

campaignsRouter.openapi(retryRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const campaign = await loadForCaller(db, c.get("allowedInboxes")!, id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (!canPerform("retry", campaign.status)) {
    return c.json(transitionError("retry", campaign.status), 409);
  }

  const recoverable = await db
    .select({ id: campaignRecipients.id })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, id),
        sql`${campaignRecipients.status} IN ('queued', 'retrying', 'retryable_failed')`,
      ),
    );

  if (recoverable.length === 0) return c.json({ requeued: 0 });

  await db
    .update(campaigns)
    .set({ status: "sending", updatedAt: now() })
    .where(eq(campaigns.id, id));

  // Chunked to the same limit the coordinator uses.
  for (let i = 0; i < recoverable.length; i += 100) {
    await c.env.EMAIL_QUEUE.sendBatch(
      recoverable.slice(i, i + 100).map((r) => ({
        body: {
          type: "campaign_send",
          campaignId: id,
          campaignRecipientId: r.id,
        } satisfies CampaignSendMessage,
      })),
    );
  }
  return c.json({ requeued: recoverable.length });
});

// --- GET /:id/preview ---

const previewRoute = createRoute({
  method: "get",
  path: "/{id}/preview",
  tags: ["Campaigns"],
  description:
    "Render the campaign with sample values. Never sends and never creates recipients.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(
      z.object({ subject: z.string(), html: z.string() }),
      "Rendered preview",
    ),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

campaignsRouter.openapi(previewRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const campaign = await loadForCaller(db, c.get("allowedInboxes")!, id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const templates = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, campaign.templateSlug))
    .limit(1);
  // A sent campaign previews its frozen copy; a draft previews the live
  // template, which is what the operator is still editing.
  const html = campaign.htmlSnapshot ?? templates[0]?.bodyHtml;
  if (html === undefined) return c.json({ error: "Template not found" }, 404);

  const vars = {
    unsubscribe_url: `${c.env.BASE_URL.replace(/\/+$/, "")}/unsubscribe?token=preview`,
    subscriber_name: "Sample Subscriber",
    subscriber_email: "sample@example.com",
  };
  return c.json({
    subject: interpolate(campaign.subjectSnapshot ?? campaign.subject, vars, {
      escape: false,
    }),
    html: interpolate(html, vars),
  });
});

// --- POST /:id/test-send ---

const testSendRoute = createRoute({
  method: "post",
  path: "/{id}/test-send",
  tags: ["Campaigns"],
  description:
    "Send one real copy to a chosen address. Creates no campaign_recipients rows and does not affect stats, so a test cannot be mistaken for delivery.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ to: z.string().email() }),
        },
      },
      required: true,
    },
  },
  responses: {
    ...json200Response(z.object({ sent: z.boolean() }), "Test sent"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Not available in this state",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

campaignsRouter.openapi(testSendRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const { to } = c.req.valid("json");
  const campaign = await loadForCaller(db, c.get("allowedInboxes")!, id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (!canPerform("test_send", campaign.status)) {
    return c.json(transitionError("test_send", campaign.status), 409);
  }

  const templates = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, campaign.templateSlug))
    .limit(1);
  const html = campaign.htmlSnapshot ?? templates[0]?.bodyHtml;
  if (html === undefined) return c.json({ error: "Template not found" }, 404);

  // A real per-list token, so the tester can verify the actual unsubscribe
  // behaviour rather than a placeholder.
  const unsubscribeUrl = await buildV2UnsubscribeUrl(c.env, {
    campaignId: campaign.id,
    listId: campaign.listId,
    contactId: "test-send",
    email: to,
  });
  const vars = {
    unsubscribe_url: unsubscribeUrl,
    subscriber_name: "Sample Subscriber",
    subscriber_email: to,
  };

  const result = await sendWithSuppressionCheck({
    db,
    env: c.env,
    sender: createEmailSender(c.env),
    from: await formatFromAddress(db, campaign.fromAddress),
    to,
    subject: `[TEST] ${interpolate(campaign.subject, vars, { escape: false })}`,
    html: interpolate(html, vars),
    transactional: false,
    unsubscribeContext: { url: unsubscribeUrl },
  });

  // No campaign_recipients row, no stats change: a test must never look like
  // delivery in the numbers.
  return c.json({ sent: result.delivered.length > 0 });
});
