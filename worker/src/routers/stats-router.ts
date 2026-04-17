import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, sql } from "drizzle-orm";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { json200Response } from "../lib/helpers";
import { inboxFilter } from "../lib/inbox-permissions";
import type { Variables } from "../variables";

export const statsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const StatsSchema = z.object({
  totalPeople: z.number(),
  totalEmails: z.number(),
  unreadCount: z.number(),
  recipients: z.array(z.string()),
  senderIdentities: z.array(
    z.object({
      email: z.string(),
      displayName: z.string().nullable(),
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
    .select({
      total: sql<number>`COUNT(*)`,
      unread: sql<number>`SUM(CASE WHEN ${emails.isRead} = 0 THEN 1 ELSE 0 END)`,
    })
    .from(emails)
    .where(whereEmails ?? sql`1=1`);
  const totalEmails = emailAgg[0]?.total ?? 0;
  const unreadCount = emailAgg[0]?.unread ?? 0;

  const personCountRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(people)
    .where(
      allowed.isAdmin
        ? sql`1=1`
        : allowed.inboxes.length === 0
          ? sql`0`
          : sql`${people.id} IN (SELECT person_id FROM ${emails} WHERE ${emails.recipient} IN ${allowed.inboxes})`,
    );

  const recipientRows = await db
    .select({ recipient: emails.recipient })
    .from(emails)
    .where(scopeFilter ?? sql`1=1`)
    .groupBy(emails.recipient);

  const allIdentities = await db.select().from(senderIdentities);
  const identityRows = allowed.isAdmin
    ? allIdentities
    : allIdentities.filter((r) => allowed.inboxes.includes(r.email));

  return c.json(
    {
      totalPeople: personCountRow[0]?.count ?? 0,
      totalEmails,
      unreadCount,
      recipients: recipientRows.map((r) => r.recipient),
      senderIdentities: identityRows.map((r) => ({
        email: r.email,
        displayName: r.displayName,
      })),
    },
    200,
  );
});
