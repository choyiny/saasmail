import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { asyncJobs } from "../db/async-jobs.schema";
import { campaignLinks } from "../db/campaign-links.schema";
import { campaignRecipients } from "../db/campaign-recipients.schema";
import { campaigns } from "../db/campaigns.schema";
import { contacts } from "../db/contacts.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { people } from "../db/people.schema";
import { sentEmails } from "../db/sent-emails.schema";
import {
  checkCampaignCompletion,
  claimRecipient,
  reconcileCampaignBookkeeping,
  refreshCampaignStats,
  runCampaignFanOutPage,
  sendCampaignRecipient,
  snapshotCampaign,
} from "../lib/campaign-sender";
import { htmlToText } from "../lib/html-to-text";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";

beforeAll(applyMigrations);
beforeEach(cleanDb);

const CAMPAIGN = "camp-1";
const LIST = "list-1";
const JOB = "job-1";
const now = () => Math.floor(Date.now() / 1000);

function fakeSender(result: SendEmailResult): EmailSender & {
  calls: SendEmailParams[];
} {
  const calls: SendEmailParams[] = [];
  return {
    provider: "none" as const,
    calls,
    async send(params: SendEmailParams) {
      calls.push(params);
      return result;
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
  };
}

const OK: SendEmailResult = { id: "prov-1", error: null };
const PERMANENT: SendEmailResult = {
  id: null,
  error: { message: "invalid recipient", transient: false },
};

async function seed(opts: { members?: number; status?: string } = {}) {
  const db = getDb();
  const ts = now();
  await db.insert(lists).values({
    id: LIST,
    name: "Weekly",
    description: null,
    fromAddress: "news@saasmail.test",
    doubleOptIn: 0,
    confirmationTemplateSlug: null,
    archivedAt: null,
    createdAt: ts,
    updatedAt: ts,
  });
  await db.insert(emailTemplates).values({
    id: "tpl-1",
    slug: "weekly",
    name: "Weekly",
    subject: "This week",
    bodyHtml: "<p>Hello {{subscriber_name}}</p><p>{{unsubscribe_url}}</p>",
    fromAddress: null,
    createdAt: ts,
    updatedAt: ts,
  });
  await db.insert(campaigns).values({
    id: CAMPAIGN,
    name: "Weekly #1",
    subject: "This week",
    templateSlug: "weekly",
    fromAddress: "news@saasmail.test",
    listId: LIST,
    status: (opts.status ?? "preparing") as never,
    createdAt: ts,
    updatedAt: ts,
  });
  await db.insert(asyncJobs).values({
    id: JOB,
    jobType: "campaign_fan_out",
    refId: CAMPAIGN,
    status: "running",
    cursor: null,
    createdAt: ts,
    updatedAt: ts,
  });

  for (let i = 0; i < (opts.members ?? 0); i++) {
    const id = `c-${String(i).padStart(4, "0")}`;
    await db.insert(contacts).values({
      id,
      email: `u${i}@example.com`,
      name: `User ${i}`,
      personId: null,
      createdAt: ts,
      updatedAt: ts,
    });
    await db.insert(listMembers).values({
      id: `m-${String(i).padStart(4, "0")}`,
      listId: LIST,
      contactId: id,
      email: `u${i}@example.com`,
      status: "subscribed",
      source: "api",
      formId: null,
      submittedIp: null,
      consentSource: "api",
      consentAt: ts,
      importJobId: null,
      subscribedAt: ts,
      confirmedAt: null,
      unsubscribedAt: null,
      unsubscribeReason: null,
      createdAt: ts,
    });
  }
}

const cfEnv = () => env as unknown as CloudflareBindings;

describe("htmlToText", () => {
  it("keeps link destinations, which is the point of a text part", () => {
    expect(htmlToText('<p>Read <a href="https://x.com/a">this</a></p>')).toBe(
      "Read this (https://x.com/a)",
    );
  });

  it("does not duplicate a URL used as its own label", () => {
    expect(htmlToText('<a href="https://x.com">https://x.com</a>')).toBe(
      "https://x.com",
    );
  });

  it("drops script and style content entirely", () => {
    expect(htmlToText("<style>p{color:red}</style><p>Hi</p>")).toBe("Hi");
    expect(htmlToText("<script>evil()</script><p>Hi</p>")).toBe("Hi");
  });

  it("separates paragraphs with a single blank line", () => {
    // A blank line between paragraphs is what makes the text part readable;
    // several empty blocks in a row still collapse to just one.
    expect(htmlToText("<p>One</p><p></p><p>Two</p>")).toBe("One\n\nTwo");
    expect(htmlToText("<p>One</p><p></p><p></p><p></p><p>Two</p>")).toBe(
      "One\n\nTwo",
    );
  });

  it("turns <br> into a plain line break, not a paragraph break", () => {
    expect(htmlToText("<p>One<br>Two</p>")).toBe("One\nTwo");
  });

  it("decodes entities", () => {
    expect(htmlToText("<p>Tips &amp; Tricks &#39;n stuff</p>")).toBe(
      "Tips & Tricks 'n stuff",
    );
  });
});

describe("snapshotCampaign", () => {
  it("freezes the rendered content and derives a text part", async () => {
    await seed();
    // null means snapshotted; a string would be the reason it could not be.
    expect(await snapshotCampaign(getDb(), CAMPAIGN, now())).toBeNull();

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    expect(c.htmlSnapshot).toContain("{{subscriber_name}}");
    expect(c.subjectSnapshot).toBe("This week");
    expect(c.textSnapshot).not.toBeNull();
    // Provenance only: which template version produced this, not an FK.
    expect(c.templateRevision).toMatch(/^tpl-1@\d+$/);
  });

  it("prefers an admin-authored text body over the derived one", async () => {
    await seed();
    await getDb()
      .update(campaigns)
      .set({ textBodyOverride: "Bespoke plain text" })
      .where(eq(campaigns.id, CAMPAIGN));

    await snapshotCampaign(getDb(), CAMPAIGN, now());
    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    expect(c.textSnapshot).toBe("Bespoke plain text");
  });

  /**
   * The immutability guarantee: once snapshotted, editing the source template
   * cannot change mail already going out.
   */
  it("is unaffected by a later template edit", async () => {
    await seed();
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await getDb()
      .update(emailTemplates)
      .set({ bodyHtml: "<p>REWRITTEN</p>" })
      .where(eq(emailTemplates.id, "tpl-1"));

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    expect(c.htmlSnapshot).not.toContain("REWRITTEN");
  });

  it("reports a missing template rather than sending blank mail", async () => {
    await seed();
    await getDb().delete(emailTemplates);
    expect(await snapshotCampaign(getDb(), CAMPAIGN, now())).toMatch(
      /Template .* not found/,
    );
  });
});

describe("claimRecipient", () => {
  async function seedRecipient(status: string) {
    await getDb()
      .insert(campaignRecipients)
      .values({
        id: "cr-1",
        campaignId: CAMPAIGN,
        contactId: "c-0000",
        email: "u0@example.com",
        status: status as never,
        idempotencyKey: `${CAMPAIGN}:c-0000`,
        attempts: 0,
        queuedAt: now(),
      });
  }

  /**
   * The duplicate-delivery guard. A read-then-write check lets two deliveries
   * of the same queue message both pass before either writes, and the
   * subscriber gets the campaign twice.
   */
  it("lets exactly one of two concurrent claims win", async () => {
    await seed();
    await seedRecipient("queued");

    const [a, b] = await Promise.all([
      claimRecipient(getDb(), "cr-1"),
      claimRecipient(getDb(), "cr-1"),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it.each(["queued", "retrying", "retryable_failed"])(
    "claims a %s recipient",
    async (status) => {
      await seed();
      await seedRecipient(status);
      expect(await claimRecipient(getDb(), "cr-1")).not.toBeNull();
    },
  );

  it.each(["sent", "suppressed", "permanent_failed", "unknown", "processing"])(
    "refuses to claim a %s recipient",
    async (status) => {
      await seed();
      await seedRecipient(status);
      // permanent_failed and unknown must never be resent, automatically or
      // manually; sent/suppressed are already terminal.
      expect(await claimRecipient(getDb(), "cr-1")).toBeNull();
    },
  );

  it("increments attempts on a successful claim", async () => {
    await seed();
    await seedRecipient("queued");
    await claimRecipient(getDb(), "cr-1");
    const r = (
      await getDb()
        .select()
        .from(campaignRecipients)
        .where(eq(campaignRecipients.id, "cr-1"))
    )[0];
    expect(r.attempts).toBe(1);
    expect(r.status).toBe("processing");
  });
});

describe("runCampaignFanOutPage", () => {
  it("enumerates members, sets the target count and flips to sending", async () => {
    await seed({ members: 3 });
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    expect(c.statsTargeted).toBe(3);

    const recipients = await getDb().select().from(campaignRecipients);
    expect(recipients).toHaveLength(3);
    expect(recipients[0].status).toBe("queued");
    expect(recipients[0].idempotencyKey).toBe(`${CAMPAIGN}:c-0000`);

    // Short page: enumeration is finished.
    const job = (
      await getDb().select().from(asyncJobs).where(eq(asyncJobs.id, JOB))
    )[0];
    expect(job.status).toBe("completed");
  });

  /**
   * A replayed page must be harmlessly redundant. Without conflict-ignored
   * inserts the statement throws and the page can never make progress.
   */
  it("is safe to replay", async () => {
    await seed({ members: 3 });
    await snapshotCampaign(getDb(), CAMPAIGN, now());

    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
    // Rewind the job as an ambiguous sendBatch would have left it.
    await getDb()
      .update(asyncJobs)
      .set({ status: "running", cursor: null })
      .where(eq(asyncJobs.id, JOB));
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);

    expect(await getDb().select().from(campaignRecipients)).toHaveLength(3);
  });

  it("skips members who are not subscribed", async () => {
    await seed({ members: 3 });
    await getDb()
      .update(listMembers)
      .set({ status: "unsubscribed" })
      .where(eq(listMembers.id, "m-0001"));

    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);

    const recipients = await getDb().select().from(campaignRecipients);
    expect(recipients).toHaveLength(2);
    expect(recipients.map((r) => r.contactId)).not.toContain("c-0001");
  });

  it("stops when the campaign is cancelled", async () => {
    await seed({ members: 3 });
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await getDb()
      .update(campaigns)
      .set({ status: "cancelled" })
      .where(eq(campaigns.id, CAMPAIGN));

    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
    expect(await getDb().select().from(campaignRecipients)).toHaveLength(0);
  });
});

describe("sendCampaignRecipient", () => {
  async function fanOut(members = 1) {
    await seed({ members });
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
    const rows = await getDb().select().from(campaignRecipients);
    return rows[0].id;
  }

  it("sends, writes sent_emails with the campaign id, and completes", async () => {
    const id = await fanOut();
    const sender = fakeSender(OK);

    expect(await sendCampaignRecipient(getDb(), cfEnv(), sender, id)).toBe(
      "sent",
    );
    expect(sender.calls).toHaveLength(1);

    const r = (
      await getDb()
        .select()
        .from(campaignRecipients)
        .where(eq(campaignRecipients.id, id))
    )[0];
    expect(r.status).toBe("sent");
    expect(r.sentEmailId).not.toBeNull();

    const se = await getDb().select().from(sentEmails);
    expect(se).toHaveLength(1);
    expect(se[0].campaignId).toBe(CAMPAIGN);
    // A blast is not correspondence.
    expect(se[0].conversationId).toBeNull();
    // No correspondent existed, so none was invented.
    expect(se[0].personId).toBeNull();
    expect(await getDb().select().from(people)).toHaveLength(0);

    // The held outbox row is released only after all of that.
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    expect(c.status).toBe("sent");
  });

  it("carries the recipient's per-list v2 unsubscribe link", async () => {
    const id = await fanOut();
    const sender = fakeSender(OK);
    await sendCampaignRecipient(getDb(), cfEnv(), sender, id);

    const header = sender.calls[0].headers?.["List-Unsubscribe"];
    expect(header).toBeDefined();
    // Same URL in the header and the body, so one click means one thing.
    const url = header!.slice(1, -1);
    expect(sender.calls[0].html).toContain(url);
  });

  it("links to an existing correspondent without creating one", async () => {
    const id = await fanOut();
    const ts = now();
    await getDb().insert(people).values({
      id: "p-1",
      email: "u0@example.com",
      name: null,
      lastEmailAt: ts,
      unreadCount: 0,
      totalCount: 0,
      createdAt: ts,
      updatedAt: ts,
    });

    await sendCampaignRecipient(getDb(), cfEnv(), fakeSender(OK), id);

    const se = await getDb().select().from(sentEmails);
    expect(se[0].personId).toBe("p-1");
    const c = (
      await getDb().select().from(contacts).where(eq(contacts.id, "c-0000"))
    )[0];
    expect(c.personId).toBe("p-1");
    // Still exactly the one person that already existed.
    expect(await getDb().select().from(people)).toHaveLength(1);
  });

  /** The duplicate-delivery property, end to end. */
  it("a duplicate delivery makes no second provider call and no second row", async () => {
    const id = await fanOut();
    const sender = fakeSender(OK);

    await sendCampaignRecipient(getDb(), cfEnv(), sender, id);
    const second = await sendCampaignRecipient(getDb(), cfEnv(), sender, id);

    expect(second).toBe("skipped");
    expect(sender.calls).toHaveLength(1);
    expect(await getDb().select().from(sentEmails)).toHaveLength(1);
  });

  it("marks a permanent rejection and never retries it", async () => {
    const id = await fanOut();
    await sendCampaignRecipient(getDb(), cfEnv(), fakeSender(PERMANENT), id);

    const r = (
      await getDb()
        .select()
        .from(campaignRecipients)
        .where(eq(campaignRecipients.id, id))
    )[0];
    expect(r.status).toBe("permanent_failed");
    // Not claimable again, by cron or by a manual retry.
    expect(await claimRecipient(getDb(), id)).toBeNull();
  });

  it("ends a campaign with a permanent failure as completed_with_failures", async () => {
    await seed({ members: 2 });
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
    const ids = (await getDb().select().from(campaignRecipients)).map(
      (r) => r.id,
    );

    await sendCampaignRecipient(getDb(), cfEnv(), fakeSender(OK), ids[0]);
    await sendCampaignRecipient(
      getDb(),
      cfEnv(),
      fakeSender(PERMANENT),
      ids[1],
    );

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    // Never "sent": that would hide that a subscriber did not get it.
    expect(c.status).toBe("completed_with_failures");
  });
});

describe("reconcileCampaignBookkeeping", () => {
  /**
   * The crash-recovery path. The provider already accepted the message, so the
   * sweep must finish the bookkeeping without sending anything again.
   */
  it("finishes a send whose bookkeeping never committed, with no provider call", async () => {
    await seed({ members: 1 });
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
    const recipientId = (await getDb().select().from(campaignRecipients))[0].id;

    // Simulate a crash: claimed, provider accepted, outbox row held, but the
    // campaign never wrote sent_emails or terminalized the recipient.
    const ts = now();
    await getDb()
      .update(campaignRecipients)
      .set({ status: "processing" })
      .where(eq(campaignRecipients.id, recipientId));
    await getDb()
      .insert(outboxEmails)
      .values({
        id: "ob-1",
        sentEmailId: "se-crashed",
        sequenceEmailId: null,
        campaignRecipientId: recipientId,
        fromAddress: "news@saasmail.test",
        toAddress: "u0@example.com",
        subject: "This week",
        bodyHtml: "<p>Hi</p>",
        headers: JSON.stringify({ "Message-ID": "<m1@saasmail.test>" }),
        transactional: 0,
        status: "bookkeeping_pending",
        attempts: 1,
        nextRetryAt: ts,
        createdAt: ts,
        updatedAt: ts,
      });

    const n = await reconcileCampaignBookkeeping(getDb(), cfEnv());
    expect(n).toBe(1);

    const r = (
      await getDb()
        .select()
        .from(campaignRecipients)
        .where(eq(campaignRecipients.id, recipientId))
    )[0];
    expect(r.status).toBe("sent");

    const se = await getDb().select().from(sentEmails);
    expect(se).toHaveLength(1);
    expect(se[0].id).toBe("se-crashed");
    expect(se[0].messageId).toBe("<m1@saasmail.test>");

    // The held row is gone, so it cannot be reconciled twice.
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
  });

  it("is idempotent when the recipient is already sent", async () => {
    await seed({ members: 1 });
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
    const id = (await getDb().select().from(campaignRecipients))[0].id;
    await sendCampaignRecipient(getDb(), cfEnv(), fakeSender(OK), id);

    const ts = now();
    await getDb().insert(outboxEmails).values({
      id: "ob-stale",
      sentEmailId: "se-stale",
      sequenceEmailId: null,
      campaignRecipientId: id,
      fromAddress: "news@saasmail.test",
      toAddress: "u0@example.com",
      subject: "This week",
      transactional: 0,
      status: "bookkeeping_pending",
      attempts: 1,
      nextRetryAt: ts,
      createdAt: ts,
      updatedAt: ts,
    });

    await reconcileCampaignBookkeeping(getDb(), cfEnv());
    // No duplicate sent_emails row for an already-settled recipient.
    expect(await getDb().select().from(sentEmails)).toHaveLength(1);
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
  });
});

describe("checkCampaignCompletion", () => {
  it("does not complete while enumeration is still running", async () => {
    await seed({ members: 1 });
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
    const id = (await getDb().select().from(campaignRecipients))[0].id;
    await sendCampaignRecipient(getDb(), cfEnv(), fakeSender(OK), id);

    // Re-open enumeration and add an unsettled recipient.
    await getDb()
      .update(campaigns)
      .set({ status: "sending" })
      .where(eq(campaigns.id, CAMPAIGN));
    await getDb()
      .update(asyncJobs)
      .set({ status: "running" })
      .where(eq(asyncJobs.id, JOB));

    await checkCampaignCompletion(getDb(), CAMPAIGN);
    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    expect(c.status).toBe("sending");
  });

  it("refreshes the advisory stats cache from the ledger", async () => {
    await seed({ members: 2 });
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
    const ids = (await getDb().select().from(campaignRecipients)).map(
      (r) => r.id,
    );
    await sendCampaignRecipient(getDb(), cfEnv(), fakeSender(OK), ids[0]);
    await sendCampaignRecipient(
      getDb(),
      cfEnv(),
      fakeSender(PERMANENT),
      ids[1],
    );

    await refreshCampaignStats(getDb(), CAMPAIGN);
    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    expect(c.statsDelivered).toBe(1);
    expect(c.statsPermanentFailed).toBe(1);
  });
});

describe("tracking in a real campaign send", () => {
  const TRACKED_BODY =
    "<p>Hello {{subscriber_name}}</p>" +
    '<p><a href="https://example.com/read">Read it</a></p>' +
    '<p><a href="https://example.com/read">Again</a></p>' +
    '<p><a href="mailto:hi@saasmail.test">Mail us</a></p>' +
    '<p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>';

  async function sendTracked(members = 1) {
    await seed({ members });
    await getDb()
      .update(emailTemplates)
      .set({ bodyHtml: TRACKED_BODY })
      .where(eq(emailTemplates.id, "tpl-1"));
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);

    const recipients = await getDb().select().from(campaignRecipients);
    const sender = fakeSender(OK);
    for (const r of recipients) {
      await sendCampaignRecipient(getDb(), cfEnv(), sender, r.id);
    }
    return sender;
  }

  it("replaces destinations with per-recipient redirects and adds a pixel", async () => {
    const sender = await sendTracked();
    const html = sender.calls[0].html!;

    expect(html).toContain("/track/open/");
    expect(html).toContain("/track/click/");
    // The destination itself never reaches the reader's HTML.
    expect(html).not.toContain("https://example.com/read");
    expect(html).not.toContain("click.invalid");
  });

  it("stores one link row for a URL used twice", async () => {
    await sendTracked();
    const links = await getDb().select().from(campaignLinks);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/read");
  });

  it("leaves the unsubscribe link and non-http schemes alone", async () => {
    const sender = await sendTracked();
    const html = sender.calls[0].html!;

    const header = sender.calls[0].headers?.["List-Unsubscribe"]!;
    const unsubUrl = header.slice(1, -1);
    // The unsubscribe link must stay an unsubscribe link — routing it through
    // click tracking would put a redirect between a reader and their opt-out.
    expect(html).toContain(`href="${unsubUrl}"`);
    expect(html).toContain('href="mailto:hi@saasmail.test"');
  });

  it("keeps real URLs in the text part", async () => {
    const sender = await sendTracked();
    const text = sender.calls[0].text!;

    // Opaque redirect URLs in plain text read as phishing and cost more
    // deliverability than the attribution is worth.
    expect(text).toContain("https://example.com/read");
    expect(text).not.toContain("/track/click/");
    expect(text).not.toContain("/track/open/");
  });

  it("gives each recipient their own pixel", async () => {
    const sender = await sendTracked(2);
    expect(sender.calls).toHaveLength(2);

    const pixel = (html: string) =>
      html.match(/\/track\/open\/([^"]+)/)?.[1] ?? "";
    expect(pixel(sender.calls[0].html!)).not.toBe("");
    expect(pixel(sender.calls[0].html!)).not.toBe(pixel(sender.calls[1].html!));
  });
});

describe("multi-page fan-out", () => {
  /**
   * Fast bulk seed. The shared `seed()` inserts row by row, which is fine for
   * three members and far too slow for several pages' worth. Chunked to stay
   * under D1's 100 bound-parameter cap.
   */
  async function seedMany(members: number) {
    await seed({ members: 0 });
    const ts = now();
    const db = getDb();
    const contactRows = [];
    const memberRows = [];
    for (let i = 0; i < members; i++) {
      const id = `c-${String(i).padStart(4, "0")}`;
      contactRows.push({
        id,
        email: `u${i}@example.com`,
        name: `User ${i}`,
        personId: null,
        createdAt: ts,
        updatedAt: ts,
      });
      memberRows.push({
        id: `m-${String(i).padStart(4, "0")}`,
        listId: LIST,
        contactId: id,
        email: `u${i}@example.com`,
        status: "subscribed" as const,
        source: "api" as const,
        formId: null,
        submittedIp: null,
        consentSource: "api" as const,
        consentAt: ts,
        importJobId: null,
        subscribedAt: ts,
        confirmedAt: null,
        unsubscribedAt: null,
        unsubscribeReason: null,
        createdAt: ts,
      });
    }
    for (let i = 0; i < contactRows.length; i += 10) {
      await db.insert(contacts).values(contactRows.slice(i, i + 10));
    }
    for (let i = 0; i < memberRows.length; i += 5) {
      await db.insert(listMembers).values(memberRows.slice(i, i + 5));
    }
  }

  const job = async () =>
    (await getDb().select().from(asyncJobs).where(eq(asyncJobs.id, JOB)))[0];

  /** Drive the coordinator the way the queue would, until it stops. */
  async function runToCompletion(maxPages = 20) {
    let pages = 0;
    while (pages < maxPages) {
      const before = await job();
      if (before.status !== "running") break;
      await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
      pages++;
    }
    return pages;
  }

  it("enumerates every member across pages, exactly once", async () => {
    // 250 = two full pages plus a short one, so both the "keep going" and the
    // "short page means done" branches run. FAN_OUT_PAGE_SIZE is 100.
    await seedMany(250);
    await snapshotCampaign(getDb(), CAMPAIGN, now());

    const pages = await runToCompletion();
    expect(pages).toBe(3);

    const recipients = await getDb().select().from(campaignRecipients);
    expect(recipients).toHaveLength(250);
    expect(new Set(recipients.map((r) => r.contactId)).size).toBe(250);

    const j = await job();
    expect(j.status).toBe("completed");
    expect(j.processedRows).toBe(250);
    expect(j.cursor).toBe("m-0249");
  });

  it("counts the whole list as targeted on the first page, not one page's worth", async () => {
    await seedMany(150);
    await snapshotCampaign(getDb(), CAMPAIGN, now());

    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);

    const c = (
      await getDb().select().from(campaigns).where(eq(campaigns.id, CAMPAIGN))
    )[0];
    expect(c.status).toBe("sending");
    // Targeted is fixed once, up front — a partially-enumerated campaign must
    // not report a total that grows page by page.
    expect(c.statsTargeted).toBe(150);
    expect(await getDb().select().from(campaignRecipients)).toHaveLength(100);
  });

  it("resumes from the cursor rather than starting over", async () => {
    await seedMany(150);
    await snapshotCampaign(getDb(), CAMPAIGN, now());

    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
    expect((await job()).cursor).toBe("m-0099");

    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);

    const recipients = await getDb().select().from(campaignRecipients);
    expect(recipients).toHaveLength(150);
    expect((await job()).status).toBe("completed");
  });

  it("a replayed page adds nobody twice and skips nobody", async () => {
    await seedMany(150);
    await snapshotCampaign(getDb(), CAMPAIGN, now());

    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);
    const afterFirst = await job();

    // A duplicate queue delivery of the same coordinator message: rewind the
    // cursor to where that page began and run it again. The conflict-ignored
    // insert is what makes this harmless.
    await getDb()
      .update(asyncJobs)
      .set({ cursor: null, processedRows: 0 })
      .where(eq(asyncJobs.id, JOB));
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);

    expect(await getDb().select().from(campaignRecipients)).toHaveLength(100);
    expect((await job()).cursor).toBe(afterFirst.cursor);

    await runToCompletion();
    const recipients = await getDb().select().from(campaignRecipients);
    expect(recipients).toHaveLength(150);
    expect(new Set(recipients.map((r) => r.contactId)).size).toBe(150);
  });

  it("stops enumerating when the campaign is cancelled mid-run", async () => {
    await seedMany(250);
    await snapshotCampaign(getDb(), CAMPAIGN, now());
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);

    await getDb()
      .update(campaigns)
      .set({ status: "cancelled" })
      .where(eq(campaigns.id, CAMPAIGN));
    await runCampaignFanOutPage(getDb(), cfEnv(), CAMPAIGN, JOB);

    // The first page's recipients stand; nothing further is enumerated.
    expect(await getDb().select().from(campaignRecipients)).toHaveLength(100);
  });
});
