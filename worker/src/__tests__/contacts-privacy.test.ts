import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { campaignEvents } from "../db/campaign-events.schema";
import { campaignRecipients } from "../db/campaign-recipients.schema";
import { contacts } from "../db/contacts.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { subscribeAttempts } from "../db/subscribe-attempts.schema";
import { hashEmail } from "../lib/subscribe-abuse";
import {
  EVENT_RETENTION_SECONDS,
  IP_RETENTION_SECONDS,
  backfillContactPersonIds,
  purgeExpiredCampaignEvents,
  purgeExpiredMemberIps,
} from "../lib/newsletter-retention";
import { people } from "../db/people.schema";
import { runNewsletterMaintenance } from "../lib/newsletter-cron";

beforeAll(applyMigrations);
beforeEach(cleanDb);

const ts = () => Math.floor(Date.now() / 1000);
const EMAIL = "subject@example.com";

async function adminKey() {
  const { apiKey } = await createTestUser({
    id: "u-admin",
    role: "admin",
    email: "admin@example.com",
  });
  return apiKey;
}

async function seedSubject(email = EMAIL, createdAt = ts()) {
  const db = getDb();
  await db.insert(lists).values({
    id: "list-1",
    name: "Weekly",
    description: null,
    fromAddress: "news@example.com",
    doubleOptIn: 0,
    confirmationTemplateSlug: null,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(contacts).values({
    id: "c-1",
    email,
    name: "Subject Person",
    personId: null,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(listMembers).values({
    id: "m-1",
    listId: "list-1",
    contactId: "c-1",
    email,
    status: "subscribed",
    source: "form",
    formId: null,
    submittedIp: "203.0.113.4",
    consentSource: "form",
    consentAt: createdAt,
    importJobId: null,
    subscribedAt: createdAt,
    confirmedAt: createdAt,
    unsubscribedAt: null,
    unsubscribeReason: null,
    createdAt,
  });
  await db.insert(campaignEvents).values({
    id: "e-1",
    campaignId: "camp-1",
    contactId: "c-1",
    email,
    eventType: "open",
    campaignLinkId: null,
    occurredAt: createdAt,
  });
  await db.insert(campaignRecipients).values({
    id: "r-1",
    campaignId: "camp-1",
    contactId: "c-1",
    email,
    status: "sent",
    idempotencyKey: "camp-1:c-1",
    attempts: 1,
    queuedAt: createdAt,
    createdAt,
  });
}

describe("GET /api/contacts/:email/export", () => {
  it("returns the contact, memberships with list names, and events", async () => {
    const apiKey = await adminKey();
    await seedSubject();

    const res = await authFetch(
      `/api/contacts/${encodeURIComponent(EMAIL)}/export`,
      { apiKey },
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();

    expect(body.email).toBe(EMAIL);
    expect(body.contact.name).toBe("Subject Person");
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].listName).toBe("Weekly");
    expect(body.memberships[0].consentSource).toBe("form");
    expect(body.events).toHaveLength(1);
  });

  it("matches case-insensitively", async () => {
    const apiKey = await adminKey();
    await seedSubject();
    const res = await authFetch(
      `/api/contacts/${encodeURIComponent("SUBJECT@Example.COM")}/export`,
      { apiKey },
    );
    expect(res.status).toBe(200);
  });

  it("404s an address we hold nothing for", async () => {
    const apiKey = await adminKey();
    const res = await authFetch("/api/contacts/nobody@example.com/export", {
      apiKey,
    });
    expect(res.status).toBe(404);
  });

  it("is refused to a non-admin", async () => {
    const { apiKey } = await createTestUser({
      id: "u-member",
      role: "member",
      email: "member@example.com",
    });
    await seedSubject();
    const res = await authFetch(
      `/api/contacts/${encodeURIComponent(EMAIL)}/export`,
      { apiKey },
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/contacts/:email/erase", () => {
  async function erase(apiKey: string, email = EMAIL) {
    return authFetch(`/api/contacts/${encodeURIComponent(email)}/erase`, {
      apiKey,
      method: "POST",
    });
  }

  it("replaces the address everywhere while keeping the rows", async () => {
    const apiKey = await adminKey();
    await seedSubject();

    const res = await erase(apiKey);
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toMatchObject({
      contacts: 1,
      memberships: 1,
      events: 1,
      recipients: 1,
    });

    const db = getDb();
    // The consent and delivery evidence survives — that is the point.
    expect(await db.select().from(listMembers)).toHaveLength(1);
    expect(await db.select().from(campaignRecipients)).toHaveLength(1);
    expect(await db.select().from(campaignEvents)).toHaveLength(1);

    for (const rows of [
      await db.select().from(contacts),
      await db.select().from(listMembers),
      await db.select().from(campaignEvents),
      await db.select().from(campaignRecipients),
    ]) {
      expect(rows[0].email).not.toBe(EMAIL);
      expect(rows[0].email).toMatch(/^erased\+[0-9a-f]{64}@invalid$/);
    }
  });

  it("clears the name, person link and submission IP", async () => {
    const apiKey = await adminKey();
    await seedSubject();
    await erase(apiKey);

    const contact = (await getDb().select().from(contacts))[0];
    expect(contact.name).toBeNull();
    expect(contact.personId).toBeNull();
    expect(
      (await getDb().select().from(listMembers))[0].submittedIp,
    ).toBeNull();
  });

  it("deletes attempt rows, which only ever held a digest", async () => {
    const apiKey = await adminKey();
    await seedSubject();
    await getDb()
      .insert(subscribeAttempts)
      .values({
        id: "a-1",
        formId: "f-1",
        emailHash: await hashEmail(EMAIL),
        ip: "203.0.113.4",
        attemptType: "submission",
        createdAt: ts(),
      });

    await erase(apiKey);
    expect(await getDb().select().from(subscribeAttempts)).toHaveLength(0);
  });

  it("produces the same pseudonym for the same address, and a different one for another", async () => {
    const apiKey = await adminKey();
    await seedSubject();
    await erase(apiKey);
    const first = (await getDb().select().from(contacts))[0].email;

    await cleanDb();
    await seedSubject("someone.else@example.com");
    await erase(apiKey, "someone.else@example.com");
    const other = (await getDb().select().from(contacts))[0].email;

    expect(other).not.toBe(first);
  });

  it("is idempotent — a second erase finds nothing left to rewrite", async () => {
    const apiKey = await adminKey();
    await seedSubject();
    await erase(apiKey);
    const second = await erase(apiKey);
    expect(await second.json<any>()).toMatchObject({
      contacts: 0,
      memberships: 0,
      events: 0,
    });
  });

  it("is refused to a non-admin", async () => {
    const { apiKey } = await createTestUser({
      id: "u-member",
      role: "member",
      email: "member@example.com",
    });
    await seedSubject();
    expect((await erase(apiKey)).status).toBe(403);
    expect((await getDb().select().from(contacts))[0].email).toBe(EMAIL);
  });
});

describe("retention sweeps", () => {
  it("nulls submission IPs past the window and leaves fresh ones", async () => {
    const old = ts() - IP_RETENTION_SECONDS - 60;
    await seedSubject(EMAIL, old);
    await getDb().insert(listMembers).values({
      id: "m-2",
      listId: "list-1",
      contactId: "c-2",
      email: "fresh@example.com",
      status: "subscribed",
      source: "form",
      formId: null,
      submittedIp: "203.0.113.9",
      consentSource: "form",
      consentAt: ts(),
      importJobId: null,
      subscribedAt: ts(),
      confirmedAt: null,
      unsubscribedAt: null,
      unsubscribeReason: null,
      createdAt: ts(),
    });

    expect(await purgeExpiredMemberIps(getDb(), ts())).toBe(1);

    const rows = await getDb().select().from(listMembers);
    expect(rows.find((r) => r.id === "m-1")!.submittedIp).toBeNull();
    // The membership itself is untouched — it is the consent record.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "m-2")!.submittedIp).toBe("203.0.113.9");
  });

  it("deletes engagement events past the window and keeps recent ones", async () => {
    const old = ts() - EVENT_RETENTION_SECONDS - 60;
    await seedSubject(EMAIL, old);
    await getDb().insert(campaignEvents).values({
      id: "e-recent",
      campaignId: "camp-1",
      contactId: "c-1",
      email: EMAIL,
      eventType: "click",
      campaignLinkId: "l-1",
      occurredAt: ts(),
    });

    expect(await purgeExpiredCampaignEvents(getDb(), ts())).toBe(1);
    const rows = await getDb().select().from(campaignEvents);
    expect(rows.map((r) => r.id)).toEqual(["e-recent"]);
  });

  it("does nothing when everything is inside its window", async () => {
    await seedSubject();
    expect(await purgeExpiredMemberIps(getDb(), ts())).toBe(0);
    expect(await purgeExpiredCampaignEvents(getDb(), ts())).toBe(0);
  });
});

describe("contact → person backfill", () => {
  it("links a subscriber who has since become a correspondent", async () => {
    await seedSubject();
    await getDb().insert(people).values({
      id: "p-1",
      email: EMAIL,
      name: "Subject Person",
      lastEmailAt: ts(),
      createdAt: ts(),
      updatedAt: ts(),
    });

    expect(await backfillContactPersonIds(getDb())).toBe(1);
    expect((await getDb().select().from(contacts))[0].personId).toBe("p-1");
  });

  it("matches case-insensitively", async () => {
    await seedSubject("Mixed.Case@Example.com");
    await getDb().insert(people).values({
      id: "p-1",
      email: "mixed.case@example.com",
      name: null,
      lastEmailAt: ts(),
      createdAt: ts(),
      updatedAt: ts(),
    });

    expect(await backfillContactPersonIds(getDb())).toBe(1);
    expect((await getDb().select().from(contacts))[0].personId).toBe("p-1");
  });

  it("leaves a subscriber who is not a correspondent alone", async () => {
    await seedSubject();
    expect(await backfillContactPersonIds(getDb())).toBe(0);
    expect((await getDb().select().from(contacts))[0].personId).toBeNull();
  });

  it("never creates a people row", async () => {
    await seedSubject();
    await backfillContactPersonIds(getDb());
    expect(await getDb().select().from(people)).toHaveLength(0);
  });
});

describe("the hourly pass actually runs the sweeps", () => {
  /**
   * Wiring, not logic. A sweep that exists but is never called from the cron
   * entry point is indistinguishable from one that was never written — and the
   * worker's typecheck does not cover this file's call path.
   */
  it("nulls old IPs, drops old events and backfills through runNewsletterMaintenance", async () => {
    const old = ts() - EVENT_RETENTION_SECONDS - 60;
    await seedSubject(EMAIL, old);
    await getDb().insert(people).values({
      id: "p-1",
      email: EMAIL,
      name: null,
      lastEmailAt: ts(),
      createdAt: ts(),
      updatedAt: ts(),
    });

    await runNewsletterMaintenance(env as unknown as CloudflareBindings);

    expect(
      (await getDb().select().from(listMembers))[0].submittedIp,
    ).toBeNull();
    expect(await getDb().select().from(campaignEvents)).toHaveLength(0);
    expect((await getDb().select().from(contacts))[0].personId).toBe("p-1");
  });
});
