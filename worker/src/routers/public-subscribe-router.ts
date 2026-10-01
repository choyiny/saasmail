import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { lists } from "../db/lists.schema";
import { listMembers } from "../db/list-members.schema";
import { subscribeForms } from "../db/subscribe-forms.schema";
import { findOrCreateContact } from "../lib/contacts";
import {
  MAX_SUBSCRIBE_BODY_BYTES,
  hashEmail,
  isConfirmationRateLimited,
  isIpRateLimited,
  isOriginAllowed,
  recordAttempt,
} from "../lib/subscribe-abuse";
import {
  buildConfirmUrl,
  readConfirmClaims,
  sendConfirmationEmail,
  signConfirmToken,
} from "../lib/subscribe-confirmation";
import { verifyPayload } from "../lib/signed-token";
import { MAX_LIST_MEMBERS } from "./lists-router";
import type { Variables } from "../variables";

/**
 * Public, unauthenticated subscribe endpoints.
 *
 * Mounted outside `/api` so the session/passkey/inbox middleware — which is
 * scoped to `/api/*` — never applies. This is a plain `Hono` rather than an
 * `OpenAPIHono`: the surface is an HTML form target, not a JSON API, and
 * documenting it in `/doc` alongside authenticated routes would imply it takes
 * the same credentials.
 */
export const publicSubscribeRouter = new Hono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

/**
 * One message for every rejection an abuser could learn from.
 *
 * Distinguishing "unknown form", "bad origin", "rate limited" and "already
 * subscribed" would turn this endpoint into an oracle for enumerating forms and
 * probing which addresses are already on a list.
 */
const GENERIC_REJECTION = "Unable to process this subscription.";

function clientIp(c: { req: { header: (k: string) => string | undefined } }) {
  return c.req.header("CF-Connecting-IP") ?? "0.0.0.0";
}

/** Accept both a real HTML form post and a JSON body. */
async function readSubmission(
  raw: string,
  contentType: string | undefined,
): Promise<Record<string, string>> {
  if (contentType?.includes("application/json")) {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- POST /subscribe/:formId ---

publicSubscribeRouter.post("/:formId", async (c) => {
  const db = c.get("db");
  const formId = c.req.param("formId");
  const now = Math.floor(Date.now() / 1000);

  // Read the body with a hard cap *before* parsing, so an oversized payload is
  // refused rather than parsed.
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > MAX_SUBSCRIBE_BODY_BYTES) {
    return c.json({ error: "Request body too large" }, 413);
  }

  let fields: Record<string, string>;
  try {
    fields = await readSubmission(raw, c.req.header("Content-Type"));
  } catch {
    return c.json({ error: GENERIC_REJECTION }, 422);
  }

  // Honeypot: a filled hidden field means a bot. Return the same 200 a success
  // would, and write nothing — telling the bot it was detected just teaches it
  // to stop filling the field.
  if ((fields._hp ?? "") !== "") {
    return c.json({ status: "subscribed" });
  }

  const email = (fields.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return c.json({ error: "A valid email address is required" }, 422);
  }

  const formRows = await db
    .select()
    .from(subscribeForms)
    .where(eq(subscribeForms.id, formId))
    .limit(1);
  const form = formRows[0];
  if (!form) return c.json({ error: GENERIC_REJECTION }, 403);

  if (!isOriginAllowed(form.allowedOrigins, c.req.header("Origin") ?? null)) {
    return c.json({ error: GENERIC_REJECTION }, 403);
  }

  if (form.nameRequired === 1 && (fields.name ?? "").trim() === "") {
    return c.json({ error: "A name is required" }, 422);
  }

  const ip = clientIp(c);
  if (await isIpRateLimited(db, ip, now)) {
    return c.json({ error: GENERIC_REJECTION }, 429);
  }

  const emailHash = await hashEmail(email);
  await recordAttempt(db, {
    formId,
    emailHash,
    ip,
    attemptType: "submission",
    now,
  });

  const listRows = await db
    .select()
    .from(lists)
    .where(eq(lists.id, form.listId))
    .limit(1);
  const list = listRows[0];
  if (!list || list.archivedAt !== null) {
    return c.json({ error: GENERIC_REJECTION }, 403);
  }

  const contact = await findOrCreateContact(
    db,
    email,
    fields.name ?? null,
    now,
  );

  const existingRows = await db
    .select()
    .from(listMembers)
    .where(
      and(
        eq(listMembers.listId, list.id),
        eq(listMembers.contactId, contact.id),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

  // Already subscribed: report success without re-sending anything. The
  // response is identical to a first-time signup so the endpoint cannot be used
  // to test whether an address is already on the list.
  if (existing && existing.status === "subscribed") {
    return c.json({ status: "subscribed", message: form.successMessage });
  }

  const doubleOptIn = list.doubleOptIn === 1;

  if (!existing) {
    const activeRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(listMembers)
      .where(
        and(
          eq(listMembers.listId, list.id),
          sql`${listMembers.status} != 'unsubscribed'`,
        ),
      );
    if (Number(activeRows[0]?.n ?? 0) >= MAX_LIST_MEMBERS) {
      // Generic, like every other rejection: revealing the cap tells an abuser
      // exactly how close they are to filling the list.
      return c.json({ error: GENERIC_REJECTION }, 403);
    }

    await db.insert(listMembers).values({
      id: nanoid(),
      listId: list.id,
      contactId: contact.id,
      email: contact.email,
      status: doubleOptIn ? "pending" : "subscribed",
      source: "form",
      formId: form.id,
      submittedIp: ip,
      consentSource: "form",
      consentAt: now,
      importJobId: null,
      subscribedAt: doubleOptIn ? null : now,
      confirmedAt: null,
      unsubscribedAt: null,
      unsubscribeReason: null,
      createdAt: now,
    });
  } else if (!doubleOptIn) {
    // Previously unsubscribed, single opt-in: straight back to subscribed.
    await db
      .update(listMembers)
      .set({
        status: "subscribed",
        subscribedAt: now,
        unsubscribedAt: null,
        unsubscribeReason: null,
        consentAt: now,
      })
      .where(eq(listMembers.id, existing.id));
  }

  if (!doubleOptIn) {
    return c.json({ status: "subscribed", message: form.successMessage });
  }

  // Double opt-in: send the confirmation unless this pair has already been
  // mailed too often. The membership stays `pending` either way, so the
  // response does not change — an abuser cannot tell whether mail was sent.
  if (!(await isConfirmationRateLimited(db, form.id, emailHash, now))) {
    await recordAttempt(db, {
      formId: form.id,
      emailHash,
      ip,
      attemptType: "confirmation_resend",
      now,
    });

    const token = await signConfirmToken(
      { formId: form.id, listId: list.id, contactId: contact.id },
      c.env.UNSUBSCRIBE_SECRET,
      now,
    );
    try {
      await sendConfirmationEmail({
        db,
        env: c.env,
        to: contact.email,
        fromAddress: list.fromAddress,
        listName: list.name,
        confirmUrl: buildConfirmUrl(c.env.BASE_URL, token),
        templateSlug: list.confirmationTemplateSlug,
      });
    } catch (err) {
      // A provider outage must not lose the pending membership: the subscriber
      // can re-submit and get a fresh confirmation.
      console.error("Failed to send subscribe confirmation:", err);
    }
  }

  return c.json({ status: "pending", message: form.successMessage });
});

// --- GET /subscribe/confirm/:token ---

publicSubscribeRouter.get("/confirm/:token", async (c) => {
  const db = c.get("db");
  const token = c.req.param("token");
  const now = Math.floor(Date.now() / 1000);

  const result = await verifyPayload(
    token,
    c.env.UNSUBSCRIBE_SECRET,
    "subscribe-confirm",
    { detailed: true },
  );

  if ("status" in result && result.status === "expired") {
    // 410 rather than 400 so the subscriber is told the link died of age and
    // that re-subscribing will work, instead of thinking the link was bogus.
    return c.json(
      { error: "This confirmation link has expired. Please subscribe again." },
      410,
    );
  }
  if ("status" in result && result.status === "invalid") {
    return c.json({ error: "Invalid confirmation link" }, 400);
  }

  const claims = readConfirmClaims(result as Record<string, unknown>);
  if (!claims) return c.json({ error: "Invalid confirmation link" }, 400);

  const rows = await db
    .select()
    .from(listMembers)
    .where(
      and(
        eq(listMembers.listId, claims.listId),
        eq(listMembers.contactId, claims.contactId),
      ),
    )
    .limit(1);
  const member = rows[0];
  if (!member) return c.json({ error: "Invalid confirmation link" }, 400);

  // Idempotent: a mail client that pre-fetches the link, or a subscriber who
  // clicks twice, must not see an error. Only a not-yet-confirmed row is
  // written, so the original confirmation timestamp is preserved.
  if (member.status !== "subscribed") {
    await db
      .update(listMembers)
      .set({
        status: "subscribed",
        confirmedAt: now,
        subscribedAt: member.subscribedAt ?? now,
        unsubscribedAt: null,
      })
      .where(eq(listMembers.id, member.id));
  }

  const formRows = await db
    .select()
    .from(subscribeForms)
    .where(eq(subscribeForms.id, claims.formId))
    .limit(1);
  const redirectUrl = formRows[0]?.redirectUrl ?? null;
  if (redirectUrl) return c.redirect(redirectUrl, 302);

  return c.json({ status: "subscribed" });
});
