import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { campaignEvents } from "../db/campaign-events.schema";
import { campaignLinks } from "../db/campaign-links.schema";
import { campaignRecipients } from "../db/campaign-recipients.schema";
import { campaigns } from "../db/campaigns.schema";
import { contacts } from "../db/contacts.schema";
import {
  CLICK_MARKER_ORIGIN,
  applyRecipientTracking,
  buildClickUrl,
  buildOpenPixelUrl,
  normalizeTrackableUrl,
  recordClick,
  recordOpen,
  resolveMarkersToDestinations,
  rewriteCampaignLinks,
} from "../lib/campaign-tracking";
import { signPayload } from "../lib/signed-token";

const SECRET = "test-secret-do-not-use-in-prod";

beforeAll(applyMigrations);
beforeEach(cleanDb);

const ts = () => Math.floor(Date.now() / 1000);
const cfEnv = () => env as unknown as CloudflareBindings;

const CAMPAIGN = "camp-1";
const OTHER_CAMPAIGN = "camp-2";
const CONTACT = "contact-1";
const EMAIL = "reader@example.com";

async function seedRecipient(
  campaignId = CAMPAIGN,
  contactId = CONTACT,
  email = EMAIL,
) {
  const t = ts();
  const db = getDb();
  const existing = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (existing.length === 0) {
    await db.insert(campaigns).values({
      id: campaignId,
      name: campaignId,
      subject: "Hi",
      templateSlug: "weekly",
      fromAddress: "news@example.com",
      listId: "list-1",
      status: "sending",
      createdAt: t,
      updatedAt: t,
    });
  }
  await db
    .insert(contacts)
    .values({
      id: contactId,
      email,
      name: "Reader",
      personId: null,
      createdAt: t,
      updatedAt: t,
    })
    .onConflictDoNothing();
  await db.insert(campaignRecipients).values({
    id: `r-${campaignId}-${contactId}`,
    campaignId,
    contactId,
    email,
    status: "sent",
    idempotencyKey: `${campaignId}:${contactId}`,
    queuedAt: t,
    createdAt: t,
  });
}

/**
 * The tracking endpoints defer their write with `ctx.waitUntil`, so the
 * response can land before the row does. Poll rather than assert once.
 */
async function eventually<T>(fn: () => Promise<T[]>, minLength = 1) {
  for (let i = 0; i < 50; i++) {
    const rows = await fn();
    if (rows.length >= minLength) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

const allEvents = () => getDb().select().from(campaignEvents);

describe("normalizeTrackableUrl", () => {
  it("accepts http and https", () => {
    expect(normalizeTrackableUrl("https://example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(normalizeTrackableUrl("http://example.com")).toBe(
      "http://example.com",
    );
  });

  it("skips anything still holding a template placeholder", () => {
    // This is how {{unsubscribe_url}} survives: the rewrite runs before
    // interpolation, so the placeholder is recognised structurally.
    expect(normalizeTrackableUrl("{{unsubscribe_url}}")).toBeNull();
    expect(normalizeTrackableUrl("https://x.test/{{token}}")).toBeNull();
  });

  it("skips non-http schemes and relative links", () => {
    expect(normalizeTrackableUrl("mailto:a@b.test")).toBeNull();
    expect(normalizeTrackableUrl("tel:+123")).toBeNull();
    expect(normalizeTrackableUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeTrackableUrl("/relative")).toBeNull();
    expect(normalizeTrackableUrl("#anchor")).toBeNull();
  });

  it("skips its own marker, empty values and absurd lengths", () => {
    expect(normalizeTrackableUrl(CLICK_MARKER_ORIGIN + "abc")).toBeNull();
    expect(normalizeTrackableUrl("")).toBeNull();
    expect(normalizeTrackableUrl(null)).toBeNull();
    expect(
      normalizeTrackableUrl("https://x.test/" + "a".repeat(3000)),
    ).toBeNull();
  });
});

describe("rewriteCampaignLinks", () => {
  it("stores each destination and replaces the href with a marker", async () => {
    const html = await rewriteCampaignLinks(
      getDb(),
      CAMPAIGN,
      '<p><a href="https://example.com/a">A</a></p>',
      ts(),
    );

    const links = await getDb().select().from(campaignLinks);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/a");
    expect(html).toContain(CLICK_MARKER_ORIGIN + links[0].id);
    expect(html).not.toContain("https://example.com/a");
    expect(html).toContain(">A</a>");
  });

  it("maps a repeated URL to one row and one marker", async () => {
    const html = await rewriteCampaignLinks(
      getDb(),
      CAMPAIGN,
      '<a href="https://example.com/a">1</a><a href="https://example.com/a">2</a>',
      ts(),
    );
    const links = await getDb().select().from(campaignLinks);
    expect(links).toHaveLength(1);
    expect(html.split(CLICK_MARKER_ORIGIN + links[0].id)).toHaveLength(3);
  });

  it("leaves the unsubscribe placeholder and other schemes alone", async () => {
    const html = await rewriteCampaignLinks(
      getDb(),
      CAMPAIGN,
      '<a href="{{unsubscribe_url}}">Unsubscribe</a><a href="mailto:a@b.test">Mail</a>',
      ts(),
    );
    expect(html).toContain('href="{{unsubscribe_url}}"');
    expect(html).toContain('href="mailto:a@b.test"');
    expect(await getDb().select().from(campaignLinks)).toHaveLength(0);
  });

  it("returns the HTML unchanged when there is nothing to track", async () => {
    const input = "<p>No links here</p>";
    expect(await rewriteCampaignLinks(getDb(), CAMPAIGN, input, ts())).toBe(
      input,
    );
  });

  it("is safe to run twice — the same URL keeps one row", async () => {
    const input = '<a href="https://example.com/a">A</a>';
    const first = await rewriteCampaignLinks(getDb(), CAMPAIGN, input, ts());
    const second = await rewriteCampaignLinks(getDb(), CAMPAIGN, input, ts());
    expect(second).toBe(first);
    expect(await getDb().select().from(campaignLinks)).toHaveLength(1);
  });
});

describe("applyRecipientTracking", () => {
  it("appends a pixel and swaps markers for signed URLs", async () => {
    const snapshot = await rewriteCampaignLinks(
      getDb(),
      CAMPAIGN,
      '<a href="https://example.com/a">A</a>',
      ts(),
    );
    const out = await applyRecipientTracking(cfEnv(), snapshot, {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
    });

    expect(out).toContain("/track/click/");
    expect(out).not.toContain(CLICK_MARKER_ORIGIN);
    expect(out).toMatch(
      /<img src="[^"]*\/track\/open\/[^"]+" width="1" height="1" alt="" style="display:none" \/>$/,
    );
  });

  it("never puts the destination URL inside a token", async () => {
    const snapshot = await rewriteCampaignLinks(
      getDb(),
      CAMPAIGN,
      '<a href="https://secret.example.com/reset?code=abc123">A</a>',
      ts(),
    );
    const out = await applyRecipientTracking(cfEnv(), snapshot, {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
    });
    expect(out).not.toContain("secret.example.com");
    expect(out).not.toContain("abc123");
  });

  it("gives two recipients different tokens", async () => {
    const snapshot = await rewriteCampaignLinks(
      getDb(),
      CAMPAIGN,
      '<a href="https://example.com/a">A</a>',
      ts(),
    );
    const a = await applyRecipientTracking(cfEnv(), snapshot, {
      campaignId: CAMPAIGN,
      contactId: "c-a",
    });
    const b = await applyRecipientTracking(cfEnv(), snapshot, {
      campaignId: CAMPAIGN,
      contactId: "c-b",
    });
    expect(a).not.toBe(b);
  });

  it("still adds the pixel to a body with no links", async () => {
    const out = await applyRecipientTracking(cfEnv(), "<p>Hello</p>", {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
    });
    expect(out).toContain("/track/open/");
  });
});

describe("GET /track/open/:token", () => {
  it("returns an uncacheable 1x1 GIF and records one open", async () => {
    await seedRecipient();
    const url = await buildOpenPixelUrl(cfEnv(), {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
    });

    const r = await exports.default.fetch(url);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/gif");
    expect(r.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(r.headers.get("Pragma")).toBe("no-cache");
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const rows = await eventually(allEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      campaignId: CAMPAIGN,
      contactId: CONTACT,
      email: EMAIL,
      eventType: "open",
      campaignLinkId: null,
    });
  });

  it("counts one open however many times the pixel is fetched", async () => {
    await seedRecipient();
    const url = await buildOpenPixelUrl(cfEnv(), {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
    });

    // What Apple MPP and every image proxy actually do.
    for (let i = 0; i < 5; i++) {
      expect((await exports.default.fetch(url)).status).toBe(200);
    }
    await eventually(allEvents);
    expect(await allEvents()).toHaveLength(1);
  });

  it("serves the GIF but records nothing for a forged token", async () => {
    await seedRecipient();
    const url = await buildOpenPixelUrl(cfEnv(), {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
    });
    const r = await exports.default.fetch(url.slice(0, -2) + "AA");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/gif");
    expect(await allEvents()).toHaveLength(0);
  });

  it("rejects a token minted for another domain", async () => {
    await seedRecipient();
    // Same payload, unsubscribe key. A pixel URL leaks through image caches,
    // so the reverse replay must not work either.
    const foreign = await signPayload(
      { v: 1, c: CAMPAIGN, k: CONTACT },
      SECRET,
      "unsubscribe",
    );
    const r = await exports.default.fetch(
      `http://localhost/track/open/${foreign}`,
    );
    expect(r.status).toBe(200);
    expect(await allEvents()).toHaveLength(0);
  });

  it("records nothing for a contact this campaign never targeted", async () => {
    await seedRecipient();
    const url = await buildOpenPixelUrl(cfEnv(), {
      campaignId: CAMPAIGN,
      contactId: "never-targeted",
    });
    expect((await exports.default.fetch(url)).status).toBe(200);
    expect(await allEvents()).toHaveLength(0);
  });
});

describe("GET /track/click/:token", () => {
  async function seedLink(
    campaignId = CAMPAIGN,
    url = "https://example.com/a",
  ) {
    await rewriteCampaignLinks(
      getDb(),
      campaignId,
      `<a href="${url}">A</a>`,
      ts(),
    );
    const links = await getDb()
      .select()
      .from(campaignLinks)
      .where(eq(campaignLinks.campaignId, campaignId));
    return links[0];
  }

  it("redirects to the stored destination and records one click", async () => {
    await seedRecipient();
    const link = await seedLink();
    const url = await buildClickUrl(cfEnv(), {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
      linkId: link.id,
    });

    const r = await exports.default.fetch(url, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("https://example.com/a");

    const rows = await eventually(allEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "click",
      campaignLinkId: link.id,
      email: EMAIL,
    });
  });

  it("counts one click per contact per link however many times it is followed", async () => {
    await seedRecipient();
    const link = await seedLink();
    const url = await buildClickUrl(cfEnv(), {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
      linkId: link.id,
    });

    for (let i = 0; i < 4; i++) {
      expect(
        (await exports.default.fetch(url, { redirect: "manual" })).status,
      ).toBe(302);
    }
    await eventually(allEvents);
    expect(await allEvents()).toHaveLength(1);
  });

  it("records separate clicks for separate links", async () => {
    await seedRecipient();
    await rewriteCampaignLinks(
      getDb(),
      CAMPAIGN,
      '<a href="https://example.com/a">A</a><a href="https://example.com/b">B</a>',
      ts(),
    );
    const links = await getDb().select().from(campaignLinks);
    expect(links).toHaveLength(2);

    for (const link of links) {
      const url = await buildClickUrl(cfEnv(), {
        campaignId: CAMPAIGN,
        contactId: CONTACT,
        linkId: link.id,
      });
      await exports.default.fetch(url, { redirect: "manual" });
    }
    const rows = await eventually(allEvents, 2);
    expect(rows).toHaveLength(2);
  });

  it("404s a token whose link belongs to another campaign", async () => {
    await seedRecipient();
    const link = await seedLink(OTHER_CAMPAIGN);
    const url = await buildClickUrl(cfEnv(), {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
      linkId: link.id,
    });
    const r = await exports.default.fetch(url, { redirect: "manual" });
    expect(r.status).toBe(404);
    expect(await allEvents()).toHaveLength(0);
  });

  it("404s an unknown link id", async () => {
    await seedRecipient();
    const url = await buildClickUrl(cfEnv(), {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
      linkId: "nope",
    });
    expect(
      (await exports.default.fetch(url, { redirect: "manual" })).status,
    ).toBe(404);
  });

  it("404s a token minted for the open domain", async () => {
    await seedRecipient();
    const link = await seedLink();
    const foreign = await signPayload(
      { v: 1, c: CAMPAIGN, k: CONTACT, l: link.id },
      SECRET,
      "track-open",
    );
    const r = await exports.default.fetch(
      `http://localhost/track/click/${foreign}`,
      { redirect: "manual" },
    );
    expect(r.status).toBe(404);
  });
});

describe("event recording is idempotent at the data layer", () => {
  it("keeps one open row per contact per campaign", async () => {
    await seedRecipient();
    await recordOpen(getDb(), { campaignId: CAMPAIGN, contactId: CONTACT });
    await recordOpen(getDb(), { campaignId: CAMPAIGN, contactId: CONTACT });
    expect(await allEvents()).toHaveLength(1);
  });

  it("keeps one click row per contact per link", async () => {
    await seedRecipient();
    await recordClick(getDb(), {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
      linkId: "l-1",
    });
    await recordClick(getDb(), {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
      linkId: "l-1",
    });
    expect(await allEvents()).toHaveLength(1);
  });

  it("lets the same contact open and click without colliding", async () => {
    await seedRecipient();
    await recordOpen(getDb(), { campaignId: CAMPAIGN, contactId: CONTACT });
    await recordClick(getDb(), {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
      linkId: "l-1",
    });
    expect(await allEvents()).toHaveLength(2);
  });
});

describe("link-heavy campaigns", () => {
  /**
   * A regression guard for D1's cap on bound variables per statement.
   *
   * A `campaign_links` row binds 4 variables, so a single INSERT of every
   * distinct link in a rich newsletter blows the cap and fails outright with
   * "too many SQL variables". 60 links is an ordinary link digest, not an
   * adversarial input.
   */
  it("stores and rewrites 60 distinct links", async () => {
    const urls = Array.from(
      { length: 60 },
      (_, i) => `https://example.com/story-${i}`,
    );
    const html = urls.map((u, i) => `<a href="${u}">Story ${i}</a>`).join("");

    const out = await rewriteCampaignLinks(getDb(), CAMPAIGN, html, ts());

    const links = await getDb().select().from(campaignLinks);
    expect(links).toHaveLength(60);
    expect(new Set(links.map((l) => l.url)).size).toBe(60);
    for (const url of urls) expect(out).not.toContain(url);
    expect(out.match(/click\.invalid/g)).toHaveLength(60);
  });

  it("resolves 60 markers back to destinations for preview", async () => {
    const urls = Array.from(
      { length: 60 },
      (_, i) => `https://example.com/story-${i}`,
    );
    const html = urls.map((u) => `<a href="${u}">x</a>`).join("");
    const snapshot = await rewriteCampaignLinks(getDb(), CAMPAIGN, html, ts());

    const resolved = await resolveMarkersToDestinations(
      getDb(),
      CAMPAIGN,
      snapshot,
    );
    expect(resolved).not.toContain("click.invalid");
    for (const url of urls) expect(resolved).toContain(url);
  });

  it("mints a signed URL per link for one recipient", async () => {
    const urls = Array.from(
      { length: 60 },
      (_, i) => `https://example.com/story-${i}`,
    );
    const snapshot = await rewriteCampaignLinks(
      getDb(),
      CAMPAIGN,
      urls.map((u) => `<a href="${u}">x</a>`).join(""),
      ts(),
    );

    const out = await applyRecipientTracking(cfEnv(), snapshot, {
      campaignId: CAMPAIGN,
      contactId: CONTACT,
    });
    expect(out).not.toContain("click.invalid");
    expect(out.match(/\/track\/click\//g)).toHaveLength(60);
  });
});
