import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { campaignEvents } from "../db/campaign-events.schema";
import { campaignLinks } from "../db/campaign-links.schema";
import { campaignRecipients } from "../db/campaign-recipients.schema";
import { signPayload, verifyPayload } from "./signed-token";

type Db = DrizzleD1Database<any>;

/**
 * Placeholder origin written into the snapshot in place of a real destination.
 *
 * Link rewriting happens **once per campaign**, at snapshot time, because a
 * click URL is per-recipient but the parse that finds the links is not. The
 * snapshot therefore stores an opaque marker per link, and the send path swaps
 * each marker for that recipient's signed URL — one regex over our own markers
 * instead of an HTML parse per subscriber.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so a marker that
 * somehow escaped substitution is a visibly dead link rather than something
 * that resolves against the reader's mail client.
 */
export const CLICK_MARKER_ORIGIN = "https://click.invalid/";

const CLICK_MARKER_RE = /https:\/\/click\.invalid\/([A-Za-z0-9_-]+)/g;

/** Longest destination URL we will store and sign. */
const MAX_URL_LENGTH = 2048;

/**
 * Statement-level chunk sizes, set by D1's cap on bound variables per query.
 *
 * A `campaign_links` row binds 4 variables, so 20 rows is 80. A link-heavy
 * newsletter really does carry dozens of distinct destinations, and one
 * oversized INSERT fails outright with "too many SQL variables" rather than
 * degrading.
 */
const INSERT_CHUNK_ROWS = 20;
const SELECT_CHUNK_IDS = 80;

/**
 * Decide whether an `href` from the template becomes a tracked link.
 *
 * Returns the URL to store, or `null` to leave the anchor exactly as authored.
 *
 * Anything still containing `{{` is skipped, which is how `{{unsubscribe_url}}`
 * is protected: this runs **before** interpolation, so the unsubscribe link is
 * still a placeholder here and is recognised structurally rather than by
 * string-matching a URL after the fact. `mailto:`, `tel:` and every other
 * scheme are left alone — only http(s) is ever redirected to.
 */
export function normalizeTrackableUrl(href: string | null): string | null {
  if (!href) return null;
  const url = href.trim();
  if (url === "" || url.length > MAX_URL_LENGTH) return null;
  if (url.includes("{{")) return null;
  if (url.startsWith(CLICK_MARKER_ORIGIN)) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Rewrite every trackable `<a href>` in the campaign snapshot to a marker.
 *
 * Two passes over HTMLRewriter rather than one: the ids come from the
 * database, and doing that lookup inside an element handler would serialize a
 * query per link. Collect first, resolve all ids in two statements, then
 * rewrite.
 */
export async function rewriteCampaignLinks(
  db: Db,
  campaignId: string,
  html: string,
  now: number,
): Promise<string> {
  const urls = new Set<string>();
  const collector = new HTMLRewriter()
    .on("a[href]", {
      element(el) {
        const url = normalizeTrackableUrl(el.getAttribute("href"));
        if (url) urls.add(url);
      },
    })
    .transform(new Response(html));
  await collector.text();

  if (urls.size === 0) return html;

  const list = [...urls];
  const values = list.map((url) => ({
    id: nanoid(),
    campaignId,
    url,
    createdAt: now,
  }));
  for (let i = 0; i < values.length; i += INSERT_CHUNK_ROWS) {
    await db
      .insert(campaignLinks)
      .values(values.slice(i, i + INSERT_CHUNK_ROWS))
      .onConflictDoNothing();
  }

  const rows: Array<{ id: string; url: string }> = [];
  for (let i = 0; i < list.length; i += SELECT_CHUNK_IDS) {
    rows.push(
      ...(await db
        .select({ id: campaignLinks.id, url: campaignLinks.url })
        .from(campaignLinks)
        .where(
          and(
            eq(campaignLinks.campaignId, campaignId),
            inArray(campaignLinks.url, list.slice(i, i + SELECT_CHUNK_IDS)),
          ),
        )),
    );
  }
  const idByUrl = new Map(rows.map((r) => [r.url, r.id]));

  const rewritten = new HTMLRewriter()
    .on("a[href]", {
      element(el) {
        const url = normalizeTrackableUrl(el.getAttribute("href"));
        const id = url ? idByUrl.get(url) : undefined;
        if (id) el.setAttribute("href", CLICK_MARKER_ORIGIN + id);
      },
    })
    .transform(new Response(html));

  return await rewritten.text();
}

/**
 * Turn markers back into the destinations they stand for.
 *
 * Preview and test-send render the frozen snapshot, which holds markers rather
 * than URLs. Left alone they would show `click.invalid` hrefs that resolve
 * nowhere — and a test send has no recipient row for an event to attach to
 * anyway, so there is nothing to track. These surfaces show the real
 * destination instead of a redirect.
 */
export async function resolveMarkersToDestinations(
  db: Db,
  campaignId: string,
  html: string,
): Promise<string> {
  const ids = new Set<string>();
  for (const m of html.matchAll(CLICK_MARKER_RE)) ids.add(m[1]);
  if (ids.size === 0) return html;

  const all = [...ids];
  const rows: Array<{ id: string; url: string }> = [];
  for (let i = 0; i < all.length; i += SELECT_CHUNK_IDS) {
    rows.push(
      ...(await db
        .select({ id: campaignLinks.id, url: campaignLinks.url })
        .from(campaignLinks)
        .where(
          and(
            eq(campaignLinks.campaignId, campaignId),
            inArray(campaignLinks.id, all.slice(i, i + SELECT_CHUNK_IDS)),
          ),
        )),
    );
  }
  const urlById = new Map(rows.map((r) => [r.id, r.url]));

  return html.replace(
    CLICK_MARKER_RE,
    (whole, id: string) => urlById.get(id) ?? whole,
  );
}

// --- Per-recipient token minting ---------------------------------------------

export async function buildOpenPixelUrl(
  env: CloudflareBindings,
  opts: { campaignId: string; contactId: string },
): Promise<string> {
  const token = await signPayload(
    { v: 1, c: opts.campaignId, k: opts.contactId },
    env.UNSUBSCRIBE_SECRET,
    "track-open",
  );
  return `${env.BASE_URL.replace(/\/+$/, "")}/track/open/${token}`;
}

export async function buildClickUrl(
  env: CloudflareBindings,
  opts: { campaignId: string; contactId: string; linkId: string },
): Promise<string> {
  const token = await signPayload(
    { v: 1, c: opts.campaignId, k: opts.contactId, l: opts.linkId },
    env.UNSUBSCRIBE_SECRET,
    "track-click",
  );
  return `${env.BASE_URL.replace(/\/+$/, "")}/track/click/${token}`;
}

/**
 * Give one recipient their own pixel and click URLs.
 *
 * Applied to the interpolated HTML part only. The text part deliberately keeps
 * real destination URLs: a bare opaque `/track/click/<token>` in plain text
 * reads as phishing to filters and humans alike, and costs more deliverability
 * than the attribution is worth — and a text-only reader cannot load a pixel
 * either, so there is nothing to correlate it with.
 */
export async function applyRecipientTracking(
  env: CloudflareBindings,
  html: string,
  opts: { campaignId: string; contactId: string },
): Promise<string> {
  const linkIds = new Set<string>();
  for (const m of html.matchAll(CLICK_MARKER_RE)) linkIds.add(m[1]);

  let out = html;
  if (linkIds.size > 0) {
    const signed = new Map<string, string>();
    for (const linkId of linkIds) {
      signed.set(linkId, await buildClickUrl(env, { ...opts, linkId }));
    }
    out = out.replace(
      CLICK_MARKER_RE,
      (whole, linkId: string) => signed.get(linkId) ?? whole,
    );
  }

  const pixel = await buildOpenPixelUrl(env, opts);
  return `${out}<img src="${pixel}" width="1" height="1" alt="" style="display:none" />`;
}

// --- Token verification ------------------------------------------------------

export type OpenToken = { campaignId: string; contactId: string };
export type ClickToken = OpenToken & { linkId: string };

export async function verifyOpenToken(
  token: string,
  secret: string,
): Promise<OpenToken | null> {
  const p = await verifyPayload(token, secret, "track-open");
  if (!p || p.v !== 1 || typeof p.c !== "string" || typeof p.k !== "string") {
    return null;
  }
  return { campaignId: p.c, contactId: p.k };
}

export async function verifyClickToken(
  token: string,
  secret: string,
): Promise<ClickToken | null> {
  const p = await verifyPayload(token, secret, "track-click");
  if (
    !p ||
    p.v !== 1 ||
    typeof p.c !== "string" ||
    typeof p.k !== "string" ||
    typeof p.l !== "string"
  ) {
    return null;
  }
  return { campaignId: p.c, contactId: p.k, linkId: p.l };
}

// --- Event recording ---------------------------------------------------------

/**
 * Record an engagement event, at most once.
 *
 * Dedup is the partial unique indexes on `campaign_events`, not a preceding
 * read: a bare `ON CONFLICT DO NOTHING` covers whichever of the two applies,
 * and a conflict target cannot be named for a partial index here anyway. That
 * matters because these endpoints are hit repeatedly for one real event —
 * mail clients pre-fetch, proxies retry, and Apple MPP fetches every pixel.
 *
 * The recipient row is looked up rather than trusted from the token: it
 * supplies the email (which must never travel inside a pixel URL, since those
 * leak through image caches and proxy logs), and its absence means the token
 * names someone this campaign never targeted, so nothing is recorded.
 */
async function recordEvent(
  db: Db,
  event: {
    campaignId: string;
    contactId: string;
    eventType: "open" | "click";
    campaignLinkId: string | null;
    now: number;
  },
): Promise<void> {
  const rows = await db
    .select({ email: campaignRecipients.email })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, event.campaignId),
        eq(campaignRecipients.contactId, event.contactId),
      ),
    )
    .limit(1);
  const email = rows[0]?.email;
  if (!email) return;

  await db
    .insert(campaignEvents)
    .values({
      id: nanoid(),
      campaignId: event.campaignId,
      contactId: event.contactId,
      email,
      eventType: event.eventType,
      campaignLinkId: event.campaignLinkId,
      occurredAt: event.now,
    })
    .onConflictDoNothing();
}

export function recordOpen(
  db: Db,
  opts: { campaignId: string; contactId: string; now?: number },
): Promise<void> {
  return recordEvent(db, {
    campaignId: opts.campaignId,
    contactId: opts.contactId,
    eventType: "open",
    campaignLinkId: null,
    now: opts.now ?? Math.floor(Date.now() / 1000),
  });
}

export function recordClick(
  db: Db,
  opts: {
    campaignId: string;
    contactId: string;
    linkId: string;
    now?: number;
  },
): Promise<void> {
  return recordEvent(db, {
    campaignId: opts.campaignId,
    contactId: opts.contactId,
    eventType: "click",
    campaignLinkId: opts.linkId,
    now: opts.now ?? Math.floor(Date.now() / 1000),
  });
}

/** Destination for a click token, or null if the link is gone or foreign. */
export async function resolveClickDestination(
  db: Db,
  token: ClickToken,
): Promise<string | null> {
  const rows = await db
    .select({ url: campaignLinks.url })
    .from(campaignLinks)
    .where(
      and(
        eq(campaignLinks.id, token.linkId),
        // A link belongs to exactly one campaign; requiring both means a token
        // can never redirect through a campaign it was not issued for.
        eq(campaignLinks.campaignId, token.campaignId),
      ),
    )
    .limit(1);
  const url = rows[0]?.url;
  // Re-checked at redirect time, not just at write time: this is the value
  // that ends up in a `Location` header.
  return url && /^https?:\/\//i.test(url) ? url : null;
}
