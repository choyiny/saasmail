import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { json200Response } from "../lib/helpers";
import { inboxScopeSql } from "../lib/inbox-permissions";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const inboxesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const InboxSchema = z
  .object({
    email: z.string().openapi({ example: "support@yourdomain.com" }),
    displayName: z.string().nullable().openapi({
      description: "Rendered as 'Name <email>' on outbound mail.",
      example: "Acme Support",
    }),
    displayMode: z.enum(["thread", "chat"]).openapi({
      description:
        "How this inbox's conversations are presented. 'thread' keeps subjects and quoted history; 'chat' strips them.",
    }),
    signatureHtml: z.string().nullable().openapi({
      description: "Appended to messages sent from this address, if set.",
    }),
  })
  .openapi("Inbox");

const listOwnInboxesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Inboxes"],
  security: bearerSecurity,
  description:
    "The addresses the caller may send from, with the display name and signature each one sends under. Admins get every inbox; members get the ones assigned to them. This is the non-admin half of GET /api/admin/inboxes — a client needs it to offer a From picker, and without it a member has no way to discover a fromAddress that POST /api/send will accept.",
  responses: {
    ...json200Response(
      z.array(InboxSchema),
      "Inboxes the caller may send from",
    ),
  },
});

inboxesRouter.openapi(listOwnInboxesRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;

  type Row = {
    email: string;
    displayName: string | null;
    displayMode: "thread" | "chat" | null;
    signatureHtml: string | null;
  };

  // The same universe the admin list builds — every address that has received
  // mail, plus every configured sender identity — narrowed to what this caller
  // may act on. Deriving it from the identical source is the point: the list a
  // client renders in its From picker has to be exactly the set
  // `assertInboxAllowed` will accept on POST /api/send, or the picker offers
  // addresses that 403.
  //
  // `inboxScopeSql` rather than a hand-rolled IN: it is the one place that
  // expresses the empty-grant case as a false predicate. A member with no
  // assignments must get [], and an inlined `IN ()` is a SQLite syntax error.
  const rows = await db.all<Row>(sql`
    WITH universe AS (
      SELECT DISTINCT recipient AS email FROM ${emails}
      UNION
      SELECT email FROM ${senderIdentities}
    )
    SELECT
      u.email AS email,
      s.display_name AS displayName,
      s.display_mode AS displayMode,
      s.signature_html AS signatureHtml
    FROM universe u
    LEFT JOIN ${senderIdentities} s ON s.email = u.email
    WHERE 1=1 ${inboxScopeSql(allowed, sql`LOWER(u.email)`)}
    ORDER BY u.email
  `);

  return c.json(
    rows.map((r) => ({
      email: r.email,
      displayName: r.displayName,
      // Matches the admin list: an inbox with no sender_identities row has
      // never been configured, and chat is the default presentation.
      displayMode: r.displayMode ?? ("chat" as const),
      signatureHtml: r.signatureHtml,
    })),
    200,
  );
});
