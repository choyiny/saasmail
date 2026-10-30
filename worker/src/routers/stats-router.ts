import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, sql } from "drizzle-orm";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { json200Response } from "../lib/helpers";
import {
  inboxFilter,
  isInboxAllowed,
  jsonList,
} from "../lib/inbox-permissions";
import { computeGroupedRows, GroupedQuerySchema } from "./people-router";
import type { Variables } from "../variables";

export const statsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const StatsSchema = z.object({
  totalPeople: z.number(),
  totalEmails: z.number(),
  /**
   * Unread rows (people and group conversations) in the caller's Inbox
   * folder — the same rows as `GET /api/people/grouped?folder=inbox&unread=1`
   * (narrowed to `recipient` when given), so archived, snoozed and trashed
   * rows don't count until new mail or an expired snooze brings them back.
   */
  unreadCount: z.number(),
  recipients: z.array(z.string()),
  /** Unread Inbox rows per inbox address (as `unreadCount`, per
   *  `recipient`), for folder/label counts. Inboxes with none are omitted. */
  inboxUnread: z.record(z.string(), z.number()),
  senderIdentities: z.array(
    z.object({
      email: z.string(),
      displayName: z.string().nullable(),
      signatureHtml: z.string().nullable(),
    }),
  ),
});

const statsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Stats"],
  description:
    "Get inbox statistics (filtered to caller's accessible inboxes).",
  request: {
    query: z.object({
      recipient: z
        .string()
        .optional()
        .openapi({ description: "Filter by recipient address" }),
    }),
  },
  responses: {
    ...json200Response(StatsSchema, "Inbox statistics"),
  },
});

statsRouter.openapi(statsRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { recipient } = c.req.valid("query");

  const scopeFilter = inboxFilter(allowed, emails.recipient);
  const recipientFilter = recipient
    ? sql`${emails.recipient} = ${recipient}`
    : undefined;

  const whereEmails = and(scopeFilter, recipientFilter);

  const emailAgg = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(emails)
    .where(whereEmails ?? sql`1=1`);
  const totalEmails = emailAgg[0]?.total ?? 0;

  // Unread counts follow the Inbox list, not raw unread messages: reuse the
  // grouped-list computation (the caller's archive / snooze / trash state and
  // its wake rules, the blocklist, inbox scoping) and count its rows.
  const { merged: unreadInboxRows } = await computeGroupedRows(
    c,
    GroupedQuerySchema.parse({ folder: "inbox", unread: "1" }),
    { categories: false },
  );
  // A person row belongs to every inbox it has received 1:1 mail at — the
  // same test as the list's `recipient` filter.
  const personInboxes = new Map<string, string[]>();
  if (unreadInboxRows.some((r) => r.type === "person")) {
    const pairs = await db
      .selectDistinct({ personId: emails.personId, inbox: emails.recipient })
      .from(emails)
      .where(and(sql`${emails.conversationId} IS NULL`, scopeFilter));
    for (const p of pairs) {
      const list = personInboxes.get(p.personId);
      if (list) list.push(p.inbox);
      else personInboxes.set(p.personId, [p.inbox]);
    }
  }
  const inboxUnread: Record<string, number> = {};
  let unreadCount = 0;
  for (const r of unreadInboxRows) {
    const inboxes =
      r.type === "person" ? (personInboxes.get(r.id) ?? []) : [r.inbox];
    for (const inbox of inboxes) {
      inboxUnread[inbox] = (inboxUnread[inbox] ?? 0) + 1;
    }
    if (!recipient || inboxes.includes(recipient)) unreadCount++;
  }

  const personCountRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(people)
    .where(
      allowed.isAdmin
        ? sql`1=1`
        : allowed.inboxes.length === 0
          ? sql`0`
          : sql`${people.id} IN (SELECT person_id FROM ${emails} WHERE ${emails.recipient} IN ${jsonList(allowed.inboxes)})`,
    );

  const allIdentities = await db.select().from(senderIdentities);
  const identityRows = allowed.isAdmin
    ? allIdentities
    : allIdentities.filter((r) => isInboxAllowed(allowed, r.email));

  return c.json(
    {
      totalPeople: personCountRow[0]?.count ?? 0,
      totalEmails,
      unreadCount,
      recipients: identityRows.map((r) => r.email),
      inboxUnread,
      senderIdentities: identityRows.map((r) => ({
        email: r.email,
        displayName: r.displayName,
        signatureHtml: r.signatureHtml,
      })),
    },
    200,
  );
});
