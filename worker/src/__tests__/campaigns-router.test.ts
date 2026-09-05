import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { asyncJobs } from "../db/async-jobs.schema";
import { campaignEvents } from "../db/campaign-events.schema";
import { campaignLinks } from "../db/campaign-links.schema";
import { campaignRecipients } from "../db/campaign-recipients.schema";
import { campaigns } from "../db/campaigns.schema";
import { campaignUnsubscribeAttributions } from "../db/campaign-unsubscribe-attributions.schema";
import { contacts } from "../db/contacts.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { sentEmails } from "../db/sent-emails.schema";
import {
  ALLOWED_TRANSITIONS,
  canPerform,
  type CampaignAction,
  type CampaignStatus,
} from "../lib/campaign-states";
import { beginCampaignSend } from "../routers/campaigns-router";
import { runCampaignPass } from "../lib/newsletter-cron";

beforeAll(applyMigrations);
beforeEach(cleanDb);

const FROM = "news@example.com";
const LIST = "list-1";
const ts = () => Math.floor(Date.now() / 1000);
const cfEnv = () => env as unknown as CloudflareBindings;

async function adminKey() {
  const { apiKey } = await createTestUser({
    id: "u-admin",
    role: "admin",
    email: "admin@example.com",
  });
  return apiKey;
}

async function seedListAndTemplate(members = 1) {
  const t = ts();
  await getDb().insert(lists).values({
    id: LIST,
    name: "Weekly",
    description: null,
    fromAddress: FROM,
    doubleOptIn: 0,
    confirmationTemplateSlug: null,
    archivedAt: null,
    createdAt: t,
    updatedAt: t,
  });
  await getDb().insert(emailTemplates).values({
    id: "tpl-1",
    slug: "weekly",
    name: "Weekly",
    subject: "This week",
    bodyHtml: "<p>Hi {{subscriber_name}}</p><p>{{unsubscribe_url}}</p>",
    fromAddress: null,
    createdAt: t,
    updatedAt: t,
  });
  for (let i = 0; i < members; i++) {
    await getDb()
      .insert(contacts)
      .values({
        id: `c-${i}`,
        email: `u${i}@example.com`,
        name: `User ${i}`,
        personId: null,
        createdAt: t,
        updatedAt: t,
      });
    await getDb()
      .insert(listMembers)
      .values({
        id: `m-${i}`,
        listId: LIST,
        contactId: `c-${i}`,
        email: `u${i}@example.com`,
        status: "subscribed",
        source: "api",
        formId: null,
        submittedIp: null,
        consentSource: "api",
        consentAt: t,
        importJobId: null,
        subscribedAt: t,
        confirmedAt: null,
        unsubscribedAt: null,
        unsubscribeReason: null,
        createdAt: t,
      });
  }
}

async function createCampaign(apiKey: string, overrides: object = {}) {
  const res = await authFetch("/api/campaigns", {
    apiKey,
    method: "POST",
    body: JSON.stringify({
      name: "Weekly #1",
      subject: "This week",
      templateSlug: "weekly",
      listId: LIST,
      ...overrides,
    }),
  });
  return { res, body: res.status === 201 ? await res.json<any>() : null };
}

async function setStatus(id: string, status: string) {
  await getDb()
    .update(campaigns)
    .set({ status: status as never })
    .where(eq(campaigns.id, id));
}

const ALL_STATUSES: CampaignStatus[] = [
  "draft",
  "scheduled",
  "overdue",
  "preparing",
  "sending",
  "sent",
  "completed_with_failures",
  "cancelled",
  "stalled",
];

describe("campaign state machine", () => {
  /**
   * Exhaustive rather than illustrative: this table is the only thing standing
   * between an operator and, say, re-sending a completed campaign. Every
   * (action, status) pair is asserted, so adding a status without deciding what
   * it permits fails here.
   */
  it.each(Object.keys(ALLOWED_TRANSITIONS) as CampaignAction[])(
    "%s permits exactly its listed statuses and no others",
    (action) => {
      const permitted = ALLOWED_TRANSITIONS[action];
      for (const status of ALL_STATUSES) {
        expect(canPerform(action, status)).toBe(permitted.includes(status));
      }
    },
  );

  it("never allows editing or deleting anything but a draft", () => {
    // Content is snapshotted on leaving draft; editing later would mean two
    // different emails going out under one campaign name.
    expect(ALLOWED_TRANSITIONS.edit).toEqual(["draft"]);
    expect(ALLOWED_TRANSITIONS.delete).toEqual(["draft"]);
  });

  it("never allows sending a campaign that already sent", () => {
    for (const status of ["sent", "completed_with_failures", "sending"]) {
      expect(canPerform("send", status as CampaignStatus)).toBe(false);
    }
  });

  it("allows retry only from the two stopped-part-way states", () => {
    expect(ALLOWED_TRANSITIONS.retry.sort()).toEqual([
      "completed_with_failures",
      "stalled",
    ]);
  });
});

describe("campaigns CRUD", () => {
  it("creates a draft that inherits the list's sending identity", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { res, body } = await createCampaign(apiKey);

    expect(res.status).toBe(201);
    expect(body.status).toBe("draft");
    // Never taken from the request: a campaign cannot be sent from an identity
    // the list does not use.
    expect(body.fromAddress).toBe(FROM);
  });

  it("404s for an unknown list and 409s for an archived one", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();

    const missing = await authFetch("/api/campaigns", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "X",
        subject: "S",
        templateSlug: "weekly",
        listId: "nope",
      }),
    });
    expect(missing.status).toBe(404);

    await getDb()
      .update(lists)
      .set({ archivedAt: ts() })
      .where(eq(lists.id, LIST));
    const { res } = await createCampaign(apiKey);
    expect(res.status).toBe(409);
  });

  it("refuses a list the caller is not scoped to", async () => {
    await adminKey();
    await seedListAndTemplate();
    const { apiKey } = await createTestUser({
      id: "u-m1",
      role: "member",
      email: "m1@example.com",
    });
    await getDb().insert(inboxPermissions).values({
      userId: "u-m1",
      email: "other@example.com",
      createdAt: ts(),
      createdBy: "u-admin",
    });

    const { res } = await createCampaign(apiKey);
    expect(res.status).toBe(403);
  });

  it("edits a draft and refuses to edit anything else", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);

    const ok = await authFetch(`/api/campaigns/${body.id}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ subject: "Changed" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json<any>()).subject).toBe("Changed");

    await setStatus(body.id, "sending");
    const blocked = await authFetch(`/api/campaigns/${body.id}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ subject: "Too late" }),
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json<any>()).error).toContain("sending");
  });

  it("deletes a draft but never a campaign that has sent", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);

    await setStatus(body.id, "sent");
    const blocked = await authFetch(`/api/campaigns/${body.id}`, {
      apiKey,
      method: "DELETE",
    });
    // The recipient ledger is the record of who received what.
    expect(blocked.status).toBe(409);

    await setStatus(body.id, "draft");
    const ok = await authFetch(`/api/campaigns/${body.id}`, {
      apiKey,
      method: "DELETE",
    });
    expect(ok.status).toBe(200);
    expect(await getDb().select().from(campaigns)).toHaveLength(0);
  });

  it("returns live stats computed from the ledgers", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);

    await getDb()
      .insert(campaignRecipients)
      .values([
        {
          id: "cr-1",
          campaignId: body.id,
          contactId: "c-0",
          email: "u0@example.com",
          status: "sent",
          idempotencyKey: "k1",
          attempts: 1,
          queuedAt: ts(),
        },
        {
          id: "cr-2",
          campaignId: body.id,
          contactId: "c-x",
          email: "x@example.com",
          status: "permanent_failed",
          idempotencyKey: "k2",
          attempts: 1,
          queuedAt: ts(),
        },
      ]);
    await getDb().insert(campaignUnsubscribeAttributions).values({
      id: "ua-1",
      campaignId: body.id,
      listMemberId: "m-0",
      occurredAt: ts(),
    });

    const detail = await (
      await authFetch(`/api/campaigns/${body.id}`, { apiKey })
    ).json<any>();
    expect(detail.stats.delivered).toBe(1);
    expect(detail.stats.permanentFailed).toBe(1);
    // Derived from the attribution ledger, never an incremented counter.
    expect(detail.stats.unsubscribes).toBe(1);
  });
});

describe("send", () => {
  it("snapshots, creates a fan-out job and moves to preparing", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(2);
    const { body } = await createCampaign(apiKey);

    const res = await authFetch(`/api/campaigns/${body.id}/send`, {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(200);

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, body.id))
    )[0];
    expect(c.status).toBe("preparing");
    expect(c.htmlSnapshot).not.toBeNull();
    expect(c.textSnapshot).not.toBeNull();
    expect(c.fanOutJobId).not.toBeNull();

    const jobs = await getDb().select().from(asyncJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobType).toBe("campaign_fan_out");
  });

  it("refuses a list with no subscribers", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(0);
    const { body } = await createCampaign(apiKey);

    const res = await authFetch(`/api/campaigns/${body.id}/send`, {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(422);
  });

  /**
   * An empty body must not leave the campaign stuck in `preparing` with
   * nothing to send — it has to fall back to where it started.
   *
   * This used to be "the template is gone". Deleting the seeding template is
   * now a no-op, because content is copied into the campaign at creation, so
   * the only way to reach the send path with nothing to send is an empty body.
   */
  it("rolls back to draft when the campaign has no content", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(1);
    const { body } = await createCampaign(apiKey);
    await getDb()
      .update(campaigns)
      .set({ bodyHtml: "" })
      .where(eq(campaigns.id, body.id));

    const res = await authFetch(`/api/campaigns/${body.id}/send`, {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(422);
    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, body.id))
    )[0];
    expect(c.status).toBe("draft");
  });

  /**
   * The point of copy-on-create: templates become genuinely reusable, because
   * a campaign started from one no longer depends on it surviving.
   */
  it("sends fine after the seeding template is deleted", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(1);
    const { body } = await createCampaign(apiKey);
    await getDb().delete(emailTemplates);

    const res = await authFetch(`/api/campaigns/${body.id}/send`, {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  it("refuses to send a campaign that is already sending", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(1);
    const { body } = await createCampaign(apiKey);
    await setStatus(body.id, "sending");

    const res = await authFetch(`/api/campaigns/${body.id}/send`, {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(409);
  });
});

describe("schedule and cancel", () => {
  it("schedules for the future and refuses the past", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);

    const past = await authFetch(`/api/campaigns/${body.id}/schedule`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ scheduledAt: ts() - 60 }),
    });
    // Sending immediately would surprise someone who mistyped a date.
    expect(past.status).toBe(422);

    const ok = await authFetch(`/api/campaigns/${body.id}/schedule`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ scheduledAt: ts() + 3600 }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json<any>()).status).toBe("scheduled");
  });

  it("cancels and stops the fan-out job", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(1);
    const { body } = await createCampaign(apiKey);
    await authFetch(`/api/campaigns/${body.id}/send`, {
      apiKey,
      method: "POST",
    });

    const res = await authFetch(`/api/campaigns/${body.id}/cancel`, {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).status).toBe("cancelled");

    const job = (await getDb().select().from(asyncJobs))[0];
    expect(job.status).toBe("cancelled");
  });

  it("refuses to cancel an already-sent campaign", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);
    await setStatus(body.id, "sent");

    const res = await authFetch(`/api/campaigns/${body.id}/cancel`, {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(409);
  });
});

describe("retry", () => {
  async function seedRecipients(campaignId: string) {
    const statuses = [
      "queued",
      "retrying",
      "retryable_failed",
      "permanent_failed",
      "unknown",
      "sent",
    ];
    await getDb()
      .insert(campaignRecipients)
      .values(
        statuses.map((status, i) => ({
          id: `cr-${i}`,
          campaignId,
          contactId: `c-r${i}`,
          email: `r${i}@example.com`,
          status: status as never,
          idempotencyKey: `k-${i}`,
          attempts: 1,
          queuedAt: ts(),
        })),
      );
  }

  /**
   * The rule that protects subscribers: an address the provider permanently
   * rejected, or one whose outcome is unknown, is never re-sent — not by the
   * cron and not by an operator clicking Retry.
   */
  it("re-enqueues only recoverable recipients", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);
    await setStatus(body.id, "completed_with_failures");
    await seedRecipients(body.id);

    const res = await authFetch(`/api/campaigns/${body.id}/retry`, {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(200);
    // queued + retrying + retryable_failed only.
    expect((await res.json<any>()).requeued).toBe(3);
  });

  it("refuses to retry a campaign that is not stopped", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);

    const res = await authFetch(`/api/campaigns/${body.id}/retry`, {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("is a no-op when nothing is recoverable", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);
    await setStatus(body.id, "stalled");

    const res = await authFetch(`/api/campaigns/${body.id}/retry`, {
      apiKey,
      method: "POST",
    });
    expect((await res.json<any>()).requeued).toBe(0);
  });
});

describe("preview and test-send", () => {
  it("previews with sample values and creates nothing", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);

    const res = await authFetch(`/api/campaigns/${body.id}/preview`, {
      apiKey,
    });
    expect(res.status).toBe(200);
    const preview = await res.json<any>();
    expect(preview.html).toContain("Sample Subscriber");
    expect(preview.subject).toBe("This week");

    // A preview must never look like delivery.
    expect(await getDb().select().from(campaignRecipients)).toHaveLength(0);
  });

  it("test-send creates no recipients and no stats", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);

    const res = await authFetch(`/api/campaigns/${body.id}/test-send`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ to: "me@example.com" }),
    });
    expect(res.status).toBe(200);

    expect(await getDb().select().from(campaignRecipients)).toHaveLength(0);
    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, body.id))
    )[0];
    expect(c.statsTargeted).toBe(0);
    expect(c.status).toBe("draft");
  });

  it("refuses a test-send once the campaign is sending", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate();
    const { body } = await createCampaign(apiKey);
    await setStatus(body.id, "sending");

    const res = await authFetch(`/api/campaigns/${body.id}/test-send`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ to: "me@example.com" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("hourly campaign pass", () => {
  async function seedCampaign(status: string, extra: object = {}) {
    const t = ts();
    await getDb()
      .insert(campaigns)
      .values({
        id: "camp-x",
        name: "X",
        subject: "S",
        templateSlug: "weekly",
        bodyHtml: "<p>Hi {{subscriber_name}}</p><p>{{unsubscribe_url}}</p>",
        fromAddress: FROM,
        listId: LIST,
        status: status as never,
        createdAt: t,
        updatedAt: t,
        ...extra,
      });
  }

  it("fires a campaign whose schedule has passed", async () => {
    await seedListAndTemplate(1);
    await seedCampaign("scheduled", { scheduledAt: ts() - 60 });

    await runCampaignPass(getDb(), cfEnv(), ts());

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, "camp-x"))
    )[0];
    expect(c.status).toBe("preparing");
  });

  /**
   * Neither fired nor dropped. A day-old announcement may no longer be correct,
   * so it becomes visible and waits for a human.
   */
  it("moves a long-overdue campaign to overdue instead of firing it", async () => {
    await seedListAndTemplate(1);
    await seedCampaign("scheduled", { scheduledAt: ts() - 25 * 3600 });

    await runCampaignPass(getDb(), cfEnv(), ts());

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, "camp-x"))
    )[0];
    expect(c.status).toBe("overdue");
    expect(c.htmlSnapshot).toBeNull();
  });

  it("marks a campaign stuck mid-flight as stalled", async () => {
    await seedListAndTemplate(1);
    await seedCampaign("sending");
    await getDb()
      .update(campaigns)
      .set({ updatedAt: ts() - 25 * 3600 })
      .where(eq(campaigns.id, "camp-x"));

    await runCampaignPass(getDb(), cfEnv(), ts());

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, "camp-x"))
    )[0];
    expect(c.status).toBe("stalled");
  });

  it("leaves a recently active campaign alone", async () => {
    await seedListAndTemplate(1);
    await seedCampaign("sending");

    await runCampaignPass(getDb(), cfEnv(), ts());

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, "camp-x"))
    )[0];
    expect(c.status).toBe("sending");
  });

  it("refreshes the advisory stats cache", async () => {
    await seedListAndTemplate(1);
    await seedCampaign("sending");
    await getDb().insert(campaignRecipients).values({
      id: "cr-1",
      campaignId: "camp-x",
      contactId: "c-0",
      email: "u0@example.com",
      status: "sent",
      idempotencyKey: "k",
      attempts: 1,
      queuedAt: ts(),
    });

    await runCampaignPass(getDb(), cfEnv(), ts());

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, "camp-x"))
    )[0];
    expect(c.statsDelivered).toBe(1);
  });
});

describe("campaign engagement endpoints", () => {
  const CAMPAIGN = "camp-stats";

  async function seedStatsCampaign(sentAt = ts()) {
    await getDb().insert(campaigns).values({
      id: CAMPAIGN,
      name: "Stats",
      subject: "S",
      templateSlug: "weekly",
      bodyHtml: "<p>Hi {{subscriber_name}}</p><p>{{unsubscribe_url}}</p>",
      fromAddress: FROM,
      listId: LIST,
      status: "sent",
      sentAt,
      createdAt: sentAt,
      updatedAt: sentAt,
    });
  }

  async function seedRecipient(contactId: string, status = "sent") {
    await getDb()
      .insert(campaignRecipients)
      .values({
        id: `cr-${contactId}`,
        campaignId: CAMPAIGN,
        contactId,
        email: `${contactId}@example.com`,
        status: status as never,
        idempotencyKey: `${CAMPAIGN}:${contactId}`,
        attempts: 1,
        queuedAt: ts(),
      });
  }

  async function seedLink(id: string, url: string) {
    await getDb()
      .insert(campaignLinks)
      .values({ id, campaignId: CAMPAIGN, url, createdAt: ts() });
  }

  async function seedEvent(
    id: string,
    contactId: string,
    eventType: "open" | "click",
    occurredAt: number,
    campaignLinkId: string | null = null,
  ) {
    await getDb()
      .insert(campaignEvents)
      .values({
        id,
        campaignId: CAMPAIGN,
        contactId,
        email: `${contactId}@example.com`,
        eventType,
        campaignLinkId,
        occurredAt,
      });
  }

  it("reports unique opens and clicks in the detail stats", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(1);
    await seedStatsCampaign();
    await seedRecipient("c-0");
    await seedLink("l-1", "https://example.com/a");
    await seedEvent("e-1", "c-0", "open", ts());
    await seedEvent("e-2", "c-0", "click", ts(), "l-1");

    const res = await authFetch(`/api/campaigns/${CAMPAIGN}`, { apiKey });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.stats.uniqueOpeners).toBe(1);
    expect(body.stats.uniqueClicks).toBe(1);
    expect(body.stats.delivered).toBe(1);
  });

  it("returns 24 zero-filled hourly buckets anchored to send time", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(1);
    const sentAt = Math.floor(ts() / 3600) * 3600;
    await seedStatsCampaign(sentAt);
    await seedRecipient("c-0");
    await seedEvent("e-1", "c-0", "open", sentAt + 60);
    await seedEvent("e-2", "c-1", "open", sentAt + 2 * 3600 + 5);
    await seedEvent("e-3", "c-0", "click", sentAt + 2 * 3600 + 9, "l-1");

    const res = await authFetch(`/api/campaigns/${CAMPAIGN}/stats/timeseries`, {
      apiKey,
    });
    expect(res.status).toBe(200);
    const { data } = await res.json<any>();

    expect(data).toHaveLength(24);
    expect(data[0]).toEqual({ hour: sentAt, opens: 1, clicks: 0 });
    // The quiet hour is present with zeros rather than skipped — otherwise the
    // chart's x-axis silently compresses and misreports the curve.
    expect(data[1]).toEqual({ hour: sentAt + 3600, opens: 0, clicks: 0 });
    expect(data[2]).toEqual({
      hour: sentAt + 2 * 3600,
      opens: 1,
      clicks: 1,
    });
  });

  it("excludes events outside the 24-hour window", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(1);
    const sentAt = Math.floor(ts() / 3600) * 3600;
    await seedStatsCampaign(sentAt);
    await seedEvent("e-late", "c-0", "open", sentAt + 25 * 3600);
    await seedEvent("e-early", "c-1", "open", sentAt - 3600);

    const res = await authFetch(`/api/campaigns/${CAMPAIGN}/stats/timeseries`, {
      apiKey,
    });
    const { data } = await res.json<any>();
    expect(data.every((d: any) => d.opens === 0 && d.clicks === 0)).toBe(true);
  });

  it("returns per-link clicks sorted desc with rate over delivered", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(1);
    await seedStatsCampaign();
    for (const c of ["c-0", "c-1", "c-2", "c-3"]) await seedRecipient(c);
    await seedLink("l-1", "https://example.com/popular");
    await seedLink("l-2", "https://example.com/quiet");

    await seedEvent("e-1", "c-0", "click", ts(), "l-1");
    await seedEvent("e-2", "c-1", "click", ts(), "l-1");
    await seedEvent("e-3", "c-2", "click", ts(), "l-2");

    const res = await authFetch(`/api/campaigns/${CAMPAIGN}/links`, { apiKey });
    expect(res.status).toBe(200);
    const { data } = await res.json<any>();

    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({
      url: "https://example.com/popular",
      clicks: 2,
      clickRate: 0.5,
    });
    expect(data[1].clicks).toBe(1);
  });

  it("includes links nobody clicked, so a dead link is not a missing one", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(1);
    await seedStatsCampaign();
    await seedRecipient("c-0");
    await seedLink("l-1", "https://example.com/ignored");

    const { data } = await (
      await authFetch(`/api/campaigns/${CAMPAIGN}/links`, { apiKey })
    ).json<any>();
    expect(data).toEqual([
      { url: "https://example.com/ignored", clicks: 0, clickRate: 0 },
    ]);
  });

  it("reports a zero click rate rather than dividing by zero", async () => {
    const apiKey = await adminKey();
    await seedListAndTemplate(1);
    await seedStatsCampaign();
    await seedLink("l-1", "https://example.com/a");
    await seedEvent("e-1", "c-0", "click", ts(), "l-1");

    const { data } = await (
      await authFetch(`/api/campaigns/${CAMPAIGN}/links`, { apiKey })
    ).json<any>();
    expect(data[0].clicks).toBe(1);
    expect(data[0].clickRate).toBe(0);
  });

  it("404s both endpoints for an unknown campaign", async () => {
    const apiKey = await adminKey();
    for (const path of ["/stats/timeseries", "/links"]) {
      const res = await authFetch(`/api/campaigns/nope${path}`, { apiKey });
      expect(res.status).toBe(404);
    }
  });
});

describe("preview and test-send show real destinations", () => {
  const LINKED_BODY =
    '<p><a href="https://example.com/read">Read</a></p>' +
    "<p>{{unsubscribe_url}}</p>";

  async function snapshottedCampaign(apiKey: string) {
    await seedListAndTemplate(1);
    await getDb()
      .update(emailTemplates)
      .set({ bodyHtml: LINKED_BODY })
      .where(eq(emailTemplates.id, "tpl-1"));
    const { body } = await createCampaign(apiKey);
    await authFetch(`/api/campaigns/${body.id}/send`, {
      apiKey,
      method: "POST",
    });
    return body.id as string;
  }

  it("preview resolves click markers back to the destination", async () => {
    const apiKey = await adminKey();
    const id = await snapshottedCampaign(apiKey);

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, id))
    )[0];
    // The snapshot really does hold a marker — otherwise this test proves
    // nothing about the resolution.
    expect(c.htmlSnapshot).toContain("click.invalid");

    const res = await authFetch(`/api/campaigns/${id}/preview`, { apiKey });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.html).toContain("https://example.com/read");
    expect(body.html).not.toContain("click.invalid");
  });
});

describe("provider daily send limit", () => {
  const CAMPAIGN = "camp-limit";

  async function draftCampaign() {
    await seedListAndTemplate(3);
    const t = ts();
    await getDb().insert(campaigns).values({
      id: CAMPAIGN,
      name: "Limited",
      subject: "S",
      templateSlug: "weekly",
      bodyHtml: "<p>Hi {{subscriber_name}}</p><p>{{unsubscribe_url}}</p>",
      fromAddress: FROM,
      listId: LIST,
      status: "draft",
      createdAt: t,
      updatedAt: t,
    });
  }

  async function seedSentToday(count: number, fromAddress = FROM) {
    const t = ts();
    for (let i = 0; i < count; i++) {
      await getDb()
        .insert(sentEmails)
        .values({
          id: `se-${fromAddress}-${i}`,
          personId: null,
          fromAddress,
          toAddress: `x${i}@example.com`,
          subject: "prior",
          status: "sent",
          sentAt: t - 60,
          createdAt: t - 60,
        });
    }
  }

  const envWithLimit = (limit: string | undefined) =>
    ({ ...cfEnv(), PROVIDER_DAILY_SEND_LIMIT: limit }) as CloudflareBindings;

  it("refuses a send that would exceed the day's quota", async () => {
    await draftCampaign();
    await seedSentToday(9);

    // 9 already sent + 3 targeted = 12, past a limit of 10.
    const failure = await beginCampaignSend(
      getDb(),
      envWithLimit("10"),
      CAMPAIGN,
    );
    expect(failure).not.toBeNull();

    // Refused up front: the campaign stays a draft rather than going out
    // half-delivered and stopping when the provider starts rejecting.
    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    expect(c.status).toBe("draft");
    expect(await getDb().select().from(campaignRecipients)).toHaveLength(0);
  });

  it("allows a send that fits", async () => {
    await draftCampaign();
    await seedSentToday(5);

    expect(
      await beginCampaignSend(getDb(), envWithLimit("100"), CAMPAIGN),
    ).toBeNull();
    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    expect(c.status).toBe("preparing");
  });

  it("is skipped entirely when the limit is unset", async () => {
    await draftCampaign();
    await seedSentToday(500);

    // Unset is the default, and must commit no operator to configuring it.
    expect(
      await beginCampaignSend(getDb(), envWithLimit(undefined), CAMPAIGN),
    ).toBeNull();
  });

  it("counts only the sending identity's own recent mail", async () => {
    await draftCampaign();
    // Another identity's traffic is another provider quota; it must not
    // consume this one's.
    await seedSentToday(50, "other@example.com");

    expect(
      await beginCampaignSend(getDb(), envWithLimit("10"), CAMPAIGN),
    ).toBeNull();
  });

  it("ignores mail older than the 24-hour window", async () => {
    await draftCampaign();
    const old = ts() - 25 * 3600;
    for (let i = 0; i < 50; i++) {
      await getDb()
        .insert(sentEmails)
        .values({
          id: `se-old-${i}`,
          personId: null,
          fromAddress: FROM,
          toAddress: `x${i}@example.com`,
          subject: "yesterday",
          status: "sent",
          sentAt: old,
          createdAt: old,
        });
    }

    expect(
      await beginCampaignSend(getDb(), envWithLimit("10"), CAMPAIGN),
    ).toBeNull();
  });
});

describe("unsubscribe secret preflight", () => {
  /**
   * Regression guard from a real deployment. With no `UNSUBSCRIBE_SECRET`,
   * signing threw *after* `claimRecipient` had already moved the row to
   * `processing` — which is not a claimable state, so the queue retry found
   * nothing to do and the campaign sat in `sending` until the 24-hour stall
   * sweep. The send must refuse up front instead.
   */
  it("refuses to start a send when the secret is missing", async () => {
    await seedListAndTemplate(2);
    const t = ts();
    await getDb().insert(campaigns).values({
      id: "camp-nosecret",
      name: "No secret",
      subject: "S",
      templateSlug: "weekly",
      bodyHtml: "<p>Hi {{subscriber_name}}</p><p>{{unsubscribe_url}}</p>",
      fromAddress: FROM,
      listId: LIST,
      status: "draft",
      createdAt: t,
      updatedAt: t,
    });

    const failure = await beginCampaignSend(
      getDb(),
      { ...cfEnv(), UNSUBSCRIBE_SECRET: "" } as CloudflareBindings,
      "camp-nosecret",
    );

    expect(failure).not.toBeNull();
    expect(failure!.status).toBe(422);
    expect(failure!.error).toMatch(/UNSUBSCRIBE_SECRET/);

    // Nothing started: no recipients stranded, campaign still editable.
    const c = (
      await getDb()
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, "camp-nosecret"))
    )[0];
    expect(c.status).toBe("draft");
    expect(await getDb().select().from(campaignRecipients)).toHaveLength(0);
  });

  it("proceeds when the secret is present", async () => {
    await seedListAndTemplate(2);
    const t = ts();
    await getDb().insert(campaigns).values({
      id: "camp-secret",
      name: "Has secret",
      subject: "S",
      templateSlug: "weekly",
      bodyHtml: "<p>Hi {{subscriber_name}}</p><p>{{unsubscribe_url}}</p>",
      fromAddress: FROM,
      listId: LIST,
      status: "draft",
      createdAt: t,
      updatedAt: t,
    });

    expect(await beginCampaignSend(getDb(), cfEnv(), "camp-secret")).toBeNull();
  });
});
