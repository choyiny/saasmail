import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { campaignEvents } from "../db/campaign-events.schema";
import { campaignRecipients } from "../db/campaign-recipients.schema";
import { contacts } from "../db/contacts.schema";
import { deliveryEvents } from "../db/delivery-events.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { json200Response } from "../lib/helpers";
import { eraseAddressFromNewsletterAudit } from "../lib/audit/erase";
import type { Variables } from "../variables";

export const contactsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ErrorSchema = z.object({ error: z.string() });

/**
 * The pseudonym an erased address is replaced with.
 *
 * Keyed HMAC rather than a bare digest: email addresses are low-entropy, so a
 * plain SHA-256 is reversible with a dictionary and would not be erasure at
 * all. The prefix keeps the value obviously non-deliverable, so nothing
 * downstream mistakes it for an address.
 */
async function erasureToken(email: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(email.trim().toLowerCase()),
  );
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `erased+${hex}@invalid`;
}

// --- GET /api/contacts/:email/export ---

const exportRoute = createRoute({
  method: "get",
  path: "/{email}/export",
  tags: ["Contacts"],
  description:
    "Everything the newsletter tables hold about one address, for a subject-access request. Admin only.",
  request: { params: z.object({ email: z.string() }) },
  responses: {
    ...json200Response(
      z.object({
        email: z.string(),
        contact: z.any().nullable(),
        memberships: z.array(z.any()),
        events: z.array(z.any()),
        deliveryEvents: z.array(z.any()).openapi({
          description:
            "Bounces, complaints, rejections and failures the email provider reported for this address.",
        }),
      }),
      "Everything held for this address",
    ),
    404: {
      description: "No record of this address",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

contactsRouter.openapi(exportRoute, async (c) => {
  const db = c.get("db");
  const email = c.req.valid("param").email.trim().toLowerCase();

  const contactRows = await db
    .select()
    .from(contacts)
    .where(eq(sql`lower(${contacts.email})`, email))
    .limit(1);

  // Memberships are keyed by the denormalized email, so a subject with no
  // `contacts` row (possible after a partial import) still gets an answer.
  const memberships = await db
    .select({
      membership: listMembers,
      listName: lists.name,
    })
    .from(listMembers)
    .leftJoin(lists, eq(lists.id, listMembers.listId))
    .where(eq(sql`lower(${listMembers.email})`, email));

  const events = await db
    .select()
    .from(campaignEvents)
    .where(eq(sql`lower(${campaignEvents.email})`, email));

  // Recipients are stored lowercased, so the index serves this.
  const delivery = await db
    .select()
    .from(deliveryEvents)
    .where(eq(deliveryEvents.recipient, email));

  if (
    contactRows.length === 0 &&
    memberships.length === 0 &&
    delivery.length === 0
  ) {
    return c.json({ error: "No record of this address" }, 404);
  }

  // Logs name the subject by its erasure pseudonym, never the address: an
  // erasure would not be one if the address stayed in the logs. The same
  // subject gets the same pseudonym, so its export and erase lines still match.
  // Export does not otherwise need the secret, so a missing one only blanks
  // the pseudonym here rather than failing the request.
  const subject = c.env.UNSUBSCRIBE_SECRET
    ? await erasureToken(email, c.env.UNSUBSCRIBE_SECRET)
    : "unavailable";
  console.log(
    `[audit] contact export subject=${subject} operator=${c.get("user")?.id ?? "unknown"} at=${Math.floor(Date.now() / 1000)}`,
  );

  return c.json({
    email,
    contact: contactRows[0] ?? null,
    memberships: memberships.map((m) => ({
      ...m.membership,
      listName: m.listName,
    })),
    events,
    deliveryEvents: delivery,
  });
});

// --- POST /api/contacts/:email/erase ---

const eraseRoute = createRoute({
  method: "post",
  path: "/{email}/erase",
  tags: ["Contacts"],
  description:
    "Replace an address with a one-way pseudonym everywhere the newsletter tables hold it, and in the audit events for list members and campaign test sends, keeping the rows themselves. Admin only.",
  request: { params: z.object({ email: z.string() }) },
  responses: {
    ...json200Response(
      z.object({
        email: z.string(),
        contacts: z.number(),
        memberships: z.number(),
        events: z.number(),
        recipients: z.number(),
        auditEvents: z.number(),
        deliveryEvents: z.number(),
      }),
      "Rows rewritten",
    ),
  },
});

contactsRouter.openapi(eraseRoute, async (c) => {
  const db = c.get("db");
  const email = c.req.valid("param").email.trim().toLowerCase();
  const token = await erasureToken(email, c.env.UNSUBSCRIBE_SECRET);
  const now = Math.floor(Date.now() / 1000);

  // The rows survive; only the identifying value inside them changes. They are
  // the evidence that a suppression or a consent actually happened, and
  // deleting them would destroy the record that protects the subject.
  const contactResult = await db
    .update(contacts)
    .set({ email: token, name: null, personId: null, updatedAt: now })
    .where(eq(sql`lower(${contacts.email})`, email));

  const memberResult = await db
    .update(listMembers)
    .set({ email: token })
    .where(eq(sql`lower(${listMembers.email})`, email));

  const eventResult = await db
    .update(campaignEvents)
    .set({ email: token })
    .where(eq(sql`lower(${campaignEvents.email})`, email));

  // A delivery row holds the address in the clear too — leaving it would make
  // the erasure cosmetic.
  const recipientResult = await db
    .update(campaignRecipients)
    .set({ email: token })
    .where(eq(sql`lower(${campaignRecipients.email})`, email));

  // A provider's report keeps its kind and time; the SMTP text often quotes
  // the address, so it goes with the address.
  const deliveryResult = await db
    .update(deliveryEvents)
    .set({ recipient: token, sender: null, detail: null, smtpStatus: null })
    .where(eq(deliveryEvents.recipient, email));

  // Adding or removing a member, and a campaign test send, name the address in
  // the audit log.
  const auditCount = await eraseAddressFromNewsletterAudit(db, email, token);

  const changed = (r: any) => Number(r?.meta?.changes ?? 0);

  console.log(
    `[audit] contact erase subject=${token} operator=${c.get("user")?.id ?? "unknown"} at=${now}`,
  );

  return c.json({
    email,
    contacts: changed(contactResult),
    memberships: changed(memberResult),
    events: changed(eventResult),
    recipients: changed(recipientResult),
    auditEvents: auditCount,
    deliveryEvents: changed(deliveryResult),
  });
});
