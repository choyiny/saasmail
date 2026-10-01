import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { campaigns } from "../db/campaigns.schema";
import { campaignUnsubscribeAttributions } from "../db/campaign-unsubscribe-attributions.schema";
import { contacts } from "../db/contacts.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { signPayload } from "../lib/signed-token";
import { signToken } from "../lib/unsubscribe-token";
import {
  RESUBSCRIBE_UNDO_WINDOW_SECONDS,
  undoListUnsubscribe,
} from "../lib/list-unsubscribe";

// Matches the binding in vitest.config.test.ts.
const SECRET = "test-secret-do-not-use-in-prod";

beforeAll(applyMigrations);
beforeEach(cleanDb);

const ts = () => Math.floor(Date.now() / 1000);

const LIST = "list-1";
const OTHER_LIST = "list-2";
const CAMPAIGN = "camp-1";
const CONTACT = "contact-1";
const MEMBER = "member-1";
const EMAIL = "reader@example.com";

async function seed(
  opts: {
    campaignListId?: string;
    memberStatus?: "pending" | "subscribed" | "unsubscribed";
    unsubscribedAt?: number | null;
  } = {},
) {
  const t = ts();
  const db = getDb();

  for (const id of [LIST, OTHER_LIST]) {
    await db.insert(lists).values({
      id,
      name: id,
      description: null,
      fromAddress: "news@example.com",
      doubleOptIn: 0,
      confirmationTemplateSlug: null,
      archivedAt: null,
      createdAt: t,
      updatedAt: t,
    });
  }

  await db.insert(campaigns).values({
    id: CAMPAIGN,
    name: "Issue 1",
    subject: "Issue 1",
    templateSlug: "weekly",
    fromAddress: "news@example.com",
    listId: opts.campaignListId ?? LIST,
    status: "sent",
    createdAt: t,
    updatedAt: t,
  });

  await db.insert(contacts).values({
    id: CONTACT,
    email: EMAIL,
    name: "Reader",
    personId: null,
    createdAt: t,
    updatedAt: t,
  });

  await db.insert(listMembers).values({
    id: MEMBER,
    listId: LIST,
    contactId: CONTACT,
    email: EMAIL,
    status: opts.memberStatus ?? "subscribed",
    source: "api",
    formId: null,
    submittedIp: null,
    consentSource: "api",
    consentAt: t,
    importJobId: null,
    subscribedAt: t,
    confirmedAt: t,
    unsubscribedAt: opts.unsubscribedAt ?? null,
    unsubscribeReason: null,
    createdAt: t,
  });
}

function v2Token(
  overrides: Partial<{ e: string; l: string; c: string; k: string }> = {},
) {
  return signPayload(
    {
      v: 2,
      e: EMAIL,
      l: LIST,
      c: CAMPAIGN,
      k: CONTACT,
      ...overrides,
    },
    SECRET,
    "unsubscribe",
  );
}

const post = (path: string, token: string, extra = "") =>
  exports.default.fetch(
    `http://localhost${path}?token=${encodeURIComponent(token)}${extra}`,
    { method: "POST" },
  );

const member = async () =>
  (
    await getDb()
      .select()
      .from(listMembers)
      .where(eq(listMembers.id, MEMBER))
      .limit(1)
  )[0];

const attributions = () =>
  getDb().select().from(campaignUnsubscribeAttributions);

describe("v2 per-list unsubscribe", () => {
  it("removes the membership and credits the campaign", async () => {
    await seed();
    const r = await post("/api/unsubscribe", await v2Token());

    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      email: EMAIL,
      status: "suppressed",
      scope: "list",
      listId: LIST,
    });

    const m = await member();
    expect(m.status).toBe("unsubscribed");
    expect(m.unsubscribedAt).toBeGreaterThan(0);

    const attrs = await attributions();
    expect(attrs).toHaveLength(1);
    expect(attrs[0].campaignId).toBe(CAMPAIGN);
    expect(attrs[0].listMemberId).toBe(MEMBER);
  });

  it("does NOT write a global suppression", async () => {
    await seed();
    await post("/api/unsubscribe", await v2Token());
    expect(await getDb().query.suppressions.findMany()).toHaveLength(0);
  });

  it("records the source as the unsubscribe reason", async () => {
    await seed();
    await post("/api/unsubscribe", await v2Token(), "&source=user-link");
    expect((await member()).unsubscribeReason).toBe("user-link");
  });

  it("handles the RFC 8058 one-click POST at /unsubscribe too", async () => {
    await seed();
    const r = await post("/unsubscribe", await v2Token());
    expect(r.status).toBe(200);
    expect((await member()).status).toBe("unsubscribed");
  });

  it("is idempotent on replay: one attribution, timestamp unchanged", async () => {
    await seed();
    const token = await v2Token();
    await post("/api/unsubscribe", token);
    const first = await member();

    const r = await post("/api/unsubscribe", token);
    expect(r.status).toBe(200);

    expect(await attributions()).toHaveLength(1);
    const second = await member();
    expect(second.unsubscribedAt).toBe(first.unsubscribedAt);
    expect(second.unsubscribeReason).toBe(first.unsubscribeReason);
  });

  it("attributes exactly once when both requests land concurrently", async () => {
    await seed();
    const token = await v2Token();
    // The real pattern: a mail client's one-click POST and the reader's own
    // click on the same link, in flight at the same time.
    const [a, b] = await Promise.all([
      post("/api/unsubscribe", token),
      post("/api/unsubscribe", token, "&source=user-link"),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await attributions()).toHaveLength(1);
  });
});

describe("v2 token rejection", () => {
  it("rejects a token whose campaign belongs to a different list", async () => {
    await seed({ campaignListId: OTHER_LIST });
    const r = await post("/api/unsubscribe", await v2Token());
    expect(r.status).toBe(401);
    expect((await member()).status).toBe("subscribed");
    expect(await attributions()).toHaveLength(0);
  });

  it("rejects a token naming an unknown campaign", async () => {
    await seed();
    const r = await post("/api/unsubscribe", await v2Token({ c: "nope" }));
    expect(r.status).toBe(401);
    expect((await member()).status).toBe("subscribed");
  });

  it("rejects a token naming a contact with no membership", async () => {
    await seed();
    const r = await post("/api/unsubscribe", await v2Token({ k: "ghost" }));
    expect(r.status).toBe(401);
    expect((await member()).status).toBe("subscribed");
  });

  it("rejects a token signed for a different domain", async () => {
    await seed();
    // Byte-identical payload, signed with the open-tracking key. A pixel URL
    // travels through image caches and proxy logs; it must not be replayable
    // as an unsubscribe.
    const foreign = await signPayload(
      { v: 2, e: EMAIL, l: LIST, c: CAMPAIGN, k: CONTACT },
      SECRET,
      "track-open",
    );
    const r = await post("/api/unsubscribe", foreign);
    expect(r.status).toBe(401);
    expect((await member()).status).toBe("subscribed");
  });

  it("rejects a tampered v2 token", async () => {
    await seed();
    const token = await v2Token();
    const r = await post("/api/unsubscribe", token.slice(0, -2) + "AA");
    expect(r.status).toBe(401);
    expect((await member()).status).toBe("subscribed");
  });
});

describe("v1 tokens are unaffected", () => {
  it("still writes a global suppression and reports global scope", async () => {
    await seed();
    const r = await post("/api/unsubscribe", await signToken(EMAIL, SECRET));

    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      email: EMAIL,
      status: "suppressed",
      scope: "global",
      listId: null,
    });

    expect(await getDb().query.suppressions.findMany()).toHaveLength(1);
    // A global suppression is not a list departure; the membership is intact.
    expect((await member()).status).toBe("subscribed");
    expect(await attributions()).toHaveLength(0);
  });

  it("undo removes the suppression", async () => {
    const token = await signToken(EMAIL, SECRET);
    await post("/api/unsubscribe", token);
    const r = await post("/api/unsubscribe/undo", token);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      status: "subscribed",
      scope: "global",
    });
    expect(await getDb().query.suppressions.findMany()).toHaveLength(0);
  });
});

describe("v2 re-subscribe undo", () => {
  it("restores the membership and drops the attribution", async () => {
    await seed();
    const token = await v2Token();
    await post("/api/unsubscribe", token);

    const r = await post("/api/unsubscribe/undo", token);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      email: EMAIL,
      status: "subscribed",
      scope: "list",
      listId: LIST,
    });

    const m = await member();
    expect(m.status).toBe("subscribed");
    expect(m.unsubscribedAt).toBeNull();
    expect(m.unsubscribeReason).toBeNull();
    // Stats derive from COUNT(*) here, so an undone unsubscribe must not keep
    // counting against the campaign.
    expect(await attributions()).toHaveLength(0);
  });

  it("succeeds again when the member is already back", async () => {
    await seed();
    const token = await v2Token();
    await post("/api/unsubscribe", token);
    await post("/api/unsubscribe/undo", token);

    const r = await post("/api/unsubscribe/undo", token);
    expect(r.status).toBe(200);
    expect((await member()).status).toBe("subscribed");
  });

  it("answers 410 once the window has closed, leaving the member off the list", async () => {
    const longAgo = ts() - RESUBSCRIBE_UNDO_WINDOW_SECONDS - 60;
    await seed({ memberStatus: "unsubscribed", unsubscribedAt: longAgo });

    const r = await post("/api/unsubscribe/undo", await v2Token());
    expect(r.status).toBe(410);
    expect((await member()).status).toBe("unsubscribed");
  });

  /**
   * Driven through the library with an explicit `now` rather than over HTTP.
   * The boundary is exact, so reading the clock twice — once to seed
   * `unsubscribedAt`, once inside the handler — makes the result depend on
   * whether the two land in the same second. That passed locally and failed on
   * a slower CI runner.
   */
  it("allows undo at the last second of the window", async () => {
    const at = 1_000_000;
    await seed({ memberStatus: "unsubscribed", unsubscribedAt: at });

    const outcome = await undoListUnsubscribe(
      getDb(),
      { listId: LIST, campaignId: CAMPAIGN, contactId: CONTACT },
      { now: at + RESUBSCRIBE_UNDO_WINDOW_SECONDS },
    );

    expect(outcome.error).toBeNull();
    expect((await member()).status).toBe("subscribed");
  });

  it("refuses one second past the window", async () => {
    const at = 1_000_000;
    await seed({ memberStatus: "unsubscribed", unsubscribedAt: at });

    const outcome = await undoListUnsubscribe(
      getDb(),
      { listId: LIST, campaignId: CAMPAIGN, contactId: CONTACT },
      { now: at + RESUBSCRIBE_UNDO_WINDOW_SECONDS + 1 },
    );

    expect(outcome.error).toBe("window_closed");
    expect((await member()).status).toBe("unsubscribed");
  });

  it("treats a missing unsubscribedAt as out of window rather than open forever", async () => {
    await seed({ memberStatus: "unsubscribed", unsubscribedAt: null });
    const outcome = await undoListUnsubscribe(getDb(), {
      listId: LIST,
      campaignId: CAMPAIGN,
      contactId: CONTACT,
    });
    expect(outcome).toEqual({ error: "window_closed" });
  });

  it("rejects an undo whose campaign belongs to a different list", async () => {
    await seed({ campaignListId: OTHER_LIST, memberStatus: "unsubscribed" });
    const r = await post("/api/unsubscribe/undo", await v2Token());
    expect(r.status).toBe(401);
  });
});
