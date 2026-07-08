import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, like, or, eq, sql, and, inArray } from "drizzle-orm";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { attachments } from "../db/attachments.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { json200Response, escapeLike, escapeFts } from "../lib/helpers";
import type { Variables } from "../variables";
import type { AllowedInboxes } from "../lib/inbox-permissions";

function peopleScopeClause(allowed: AllowedInboxes) {
  if (allowed.isAdmin) return sql``;
  if (allowed.inboxes.length === 0)
    return sql`AND s.id IN (SELECT NULL WHERE 0)`;
  // A person is in scope if they emailed one of our allowed inboxes OR if we
  // sent them mail from one of our allowed inboxes.
  return sql`AND s.id IN (
    SELECT person_id FROM emails WHERE recipient IN ${allowed.inboxes}
    UNION
    SELECT person_id FROM sent_emails WHERE from_address IN ${allowed.inboxes} AND person_id IS NOT NULL
  )`;
}

export const peopleRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const PersonSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  recipient: z.string(),
  lastEmailAt: z.number(),
  unreadCount: z.number(),
  totalCount: z.number(),
  latestSubject: z.string().nullable().optional(),
});

// Grouped people (unique people, aggregated across all recipients)
const GroupedPersonSchema = z.object({
  type: z.literal("person"),
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  lastEmailAt: z.number(),
  unreadCount: z.number(),
  totalCount: z.number(),
  recipientCount: z.number(),
  recipients: z.array(z.string()),
  hasAttachment: z.number(),
});

// Group conversation row — represents a single multi-participant thread.
// Surfaced alongside person rows in the inbox list (sorted together by
// lastEmailAt). The participants array contains the senders (people) who
// posted into the thread; ccParticipants is the de-duped set of CC contacts
// (which may not be `people` rows since they're external).
const GroupedConversationSchema = z.object({
  type: z.literal("group"),
  id: z.string(),
  inbox: z.string(),
  participants: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
    }),
  ),
  ccParticipants: z.array(
    z.object({
      email: z.string(),
      name: z.string().nullable(),
    }),
  ),
  lastEmailAt: z.number(),
  unreadCount: z.number(),
  totalCount: z.number(),
  hasAttachment: z.number(),
});

const GroupedItemSchema = z.discriminatedUnion("type", [
  GroupedPersonSchema,
  GroupedConversationSchema,
]);

const listGroupedPeopleRoute = createRoute({
  method: "get",
  path: "/grouped",
  tags: ["People"],
  description:
    "List people and group conversations together (sorted by most recent activity).",
  request: {
    query: z.object({
      q: z
        .string()
        .optional()
        .openapi({ description: "Search person name/email" }),
      recipient: z.string().optional().openapi({
        description: "Filter to people who have emailed this inbox address",
      }),
      unread: z
        .enum(["1", "true"])
        .optional()
        .openapi({ description: "Only people with unread emails" }),
      hasAttachment: z
        .enum(["1", "true"])
        .optional()
        .openapi({ description: "Only people with downloadable attachments" }),
      sort: z
        .enum(["recency", "unread", "inbox", "attachments"])
        .optional()
        .default("recency")
        .openapi({
          description:
            "Sort key. Direction is controlled by the separate `direction` param.",
        }),
      direction: z.enum(["asc", "desc"]).optional().openapi({
        description:
          "Sort direction. When omitted, defaults to the natural direction for the chosen sort key (recency/unread/attachments default to desc; inbox defaults to asc).",
      }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        data: z.array(GroupedItemSchema),
        total: z.number(),
        page: z.number(),
        limit: z.number(),
        // Aggregates over the *filtered* set (not just the page) — power
        // the stat tiles in table view so they reflect every row that
        // matches the current filters, not just the 40 on screen.
        aggregates: z.object({
          unreadRowCount: z.number(),
          attachmentRowCount: z.number(),
          multiInboxRowCount: z.number(),
          /**
           * Sum of unread emails across the filtered set — useful for
           * the navbar's "you have N unread" feel.
           */
          totalUnreadEmails: z.number(),
        }),
      }),
      "Paginated list of grouped people + group conversations",
    ),
  },
});

peopleRouter.openapi(listGroupedPeopleRoute, async (c) => {
  const db = c.get("db");
  const { q, recipient, unread, hasAttachment, sort, direction, page, limit } =
    c.req.valid("query");
  const offset = (page - 1) * limit;
  // Resolve effective direction. Each sort key has a "natural" default
  // (recency/unread/attachments → desc, inbox → asc) so the UI can
  // pass `direction: undefined` to mean "use the natural one for this
  // key". Explicit values from the client always win.
  const naturalDirection: "asc" | "desc" = sort === "inbox" ? "asc" : "desc";
  const effectiveDirection: "asc" | "desc" = direction ?? naturalDirection;

  const allowed = c.get("allowedInboxes")!;

  // ----- PERSON ROWS (1-on-1 threads only — conversation_id IS NULL) -----
  const personConditions: any[] = [];
  if (recipient) {
    personConditions.push(
      sql`s.id IN (SELECT person_id FROM emails WHERE recipient = ${recipient} AND conversation_id IS NULL)`,
    );
  }
  if (unread) {
    personConditions.push(
      sql`s.id IN (SELECT person_id FROM emails WHERE is_read = 0 AND conversation_id IS NULL)`,
    );
  }
  if (hasAttachment) {
    personConditions.push(
      sql`s.id IN (SELECT e2.person_id FROM emails e2 JOIN ${attachments} a ON a.email_id = e2.id WHERE a.content_id IS NULL AND e2.conversation_id IS NULL)`,
    );
  }
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    const ftsQuery = escapeFts(q);
    const ftsInboxScope = allowed.isAdmin
      ? sql``
      : allowed.inboxes.length === 0
        ? sql`AND 0`
        : sql`AND emails.recipient IN ${allowed.inboxes}`;
    personConditions.push(
      sql`(s.email LIKE ${pattern} ESCAPE '\\' OR s.name LIKE ${pattern} ESCAPE '\\'
        OR s.id IN (
          SELECT person_id FROM emails
          JOIN emails_fts ON emails.rowid = emails_fts.rowid
          WHERE emails_fts MATCH ${ftsQuery} ${ftsInboxScope} AND emails.conversation_id IS NULL
        ))`,
    );
  }
  // Hide senders that are on the global blocklist (exact email or domain).
  // The blocklist is the source of truth; unblocking makes rows reappear.
  personConditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM blocklist b
      WHERE (b.type = 'email'  AND b.value = s.email)
         OR (b.type = 'domain' AND b.value = lower(substr(s.email, instr(s.email, '@') + 1)))
    )`,
  );
  const scopeClause = peopleScopeClause(allowed);
  const personExtraConditions =
    personConditions.length > 0
      ? sql`AND ${sql.join(personConditions, sql` AND `)}`
      : sql``;
  const personWhereClause = sql`WHERE 1=1 ${personExtraConditions} ${scopeClause}`;

  // Aggregate over both received and sent emails so people we've composed to
  // appear in the list, not just senders who have emailed us. We exclude
  // any rows with a non-null conversation_id — those belong under group rows.
  const activity = sql`(
    SELECT person_id, recipient AS inbox, received_at AS at, is_read, conversation_id
    FROM ${emails}
    UNION ALL
    SELECT person_id, from_address AS inbox, sent_at AS at, 1 AS is_read, conversation_id
    FROM ${sentEmails}
    WHERE person_id IS NOT NULL
  )`;

  const personRowsRaw = await db.all<{
    id: string;
    email: string;
    name: string | null;
    lastEmailAt: number;
    unreadCount: number;
    totalCount: number;
    recipientCount: number;
    recipientsCsv: string | null;
    hasAttachment: number;
  }>(sql`
    SELECT
      s.id,
      s.email,
      s.name,
      MAX(e.at) AS lastEmailAt,
      SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) AS unreadCount,
      COUNT(*) AS totalCount,
      COUNT(DISTINCT e.inbox) AS recipientCount,
      GROUP_CONCAT(DISTINCT e.inbox) AS recipientsCsv,
      EXISTS(
        SELECT 1 FROM ${attachments} a
        JOIN ${emails} e2 ON e2.id = a.email_id
        WHERE e2.person_id = s.id
        AND a.content_id IS NULL
        AND e2.conversation_id IS NULL
      ) AS hasAttachment
    FROM ${activity} e
    JOIN ${people} s ON s.id = e.person_id
    ${personWhereClause}
    AND e.conversation_id IS NULL
    GROUP BY s.id
    ORDER BY lastEmailAt DESC
  `);
  const personRows = personRowsRaw.map((r) => ({
    type: "person" as const,
    id: r.id,
    email: r.email,
    name: r.name,
    lastEmailAt: r.lastEmailAt,
    unreadCount: r.unreadCount,
    totalCount: r.totalCount,
    recipientCount: r.recipientCount,
    recipients: r.recipientsCsv ? r.recipientsCsv.split(",") : [],
    hasAttachment: r.hasAttachment,
  }));

  // ----- GROUP CONVERSATION ROWS (conversation_id IS NOT NULL) -----
  // Activity-style subquery scoped to the inbox set the user can see.
  const groupInboxScope = allowed.isAdmin
    ? sql``
    : allowed.inboxes.length === 0
      ? sql`AND 0`
      : sql`AND inbox IN ${allowed.inboxes}`;

  const groupConditions: any[] = [];
  if (recipient) {
    groupConditions.push(sql`g.inbox = ${recipient}`);
  }
  if (unread) {
    groupConditions.push(sql`g.unreadCount > 0`);
  }
  if (hasAttachment) {
    groupConditions.push(sql`g.hasAttachment = 1`);
  }
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    // Match by participant email/name, or any group-email subject/body via FTS,
    // or sent-email subject via LIKE (sent_emails has no FTS index).
    const ftsQuery = escapeFts(q);
    const ftsInboxScope = allowed.isAdmin
      ? sql``
      : allowed.inboxes.length === 0
        ? sql`AND 0`
        : sql`AND emails.recipient IN ${allowed.inboxes}`;
    groupConditions.push(sql`(
      g.conversation_id IN (
        SELECT DISTINCT e.conversation_id FROM ${emails} e
        JOIN ${people} p ON p.id = e.person_id
        WHERE e.conversation_id IS NOT NULL
        AND (p.email LIKE ${pattern} ESCAPE '\\' OR p.name LIKE ${pattern} ESCAPE '\\')
      )
      OR g.conversation_id IN (
        SELECT emails.conversation_id FROM emails
        JOIN emails_fts ON emails.rowid = emails_fts.rowid
        WHERE emails_fts MATCH ${ftsQuery} AND emails.conversation_id IS NOT NULL ${ftsInboxScope}
      )
      OR g.conversation_id IN (
        SELECT conversation_id FROM ${sentEmails}
        WHERE conversation_id IS NOT NULL AND subject LIKE ${pattern} ESCAPE '\\'
      )
    )`);
  }
  const groupExtraConditions =
    groupConditions.length > 0
      ? sql`AND ${sql.join(groupConditions, sql` AND `)}`
      : sql``;

  const groupRowsRaw = await db.all<{
    conversation_id: string;
    inbox: string;
    lastEmailAt: number;
    unreadCount: number;
    totalCount: number;
    hasAttachment: number;
  }>(sql`
    SELECT
      g.conversation_id,
      g.inbox,
      g.lastEmailAt,
      g.unreadCount,
      g.totalCount,
      g.hasAttachment
    FROM (
      SELECT
        conversation_id,
        inbox,
        MAX(at) AS lastEmailAt,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unreadCount,
        COUNT(*) AS totalCount,
        EXISTS(
          SELECT 1 FROM ${attachments} a
          JOIN ${emails} e2 ON e2.id = a.email_id
          WHERE e2.conversation_id = act.conversation_id
          AND a.content_id IS NULL
        ) AS hasAttachment
      FROM (
        SELECT conversation_id, recipient AS inbox, received_at AS at, is_read
        FROM ${emails}
        WHERE conversation_id IS NOT NULL
        UNION ALL
        SELECT conversation_id, from_address AS inbox, sent_at AS at, 1 AS is_read
        FROM ${sentEmails}
        WHERE conversation_id IS NOT NULL
      ) act
      WHERE 1=1 ${groupInboxScope}
      GROUP BY conversation_id, inbox
    ) g
    WHERE 1=1 ${groupExtraConditions}
    ORDER BY g.lastEmailAt DESC
  `);

  // Resolve participants (senders/people who posted into the thread) and
  // CC participants (raw email/name pairs from the cc JSON column) for each
  // group row, in two follow-up queries — keeps SQL simpler than crafting
  // a single mega-join.
  let groupRows: Array<{
    type: "group";
    id: string;
    inbox: string;
    participants: Array<{ id: string; email: string; name: string | null }>;
    ccParticipants: Array<{ email: string; name: string | null }>;
    lastEmailAt: number;
    unreadCount: number;
    totalCount: number;
    hasAttachment: number;
  }> = [];
  if (groupRowsRaw.length > 0) {
    const ids = groupRowsRaw.map((r) => r.conversation_id);

    // Participants — senders (from `emails`) + outbound senders (from
    // `sent_emails` joined to `people` when person_id is set).
    const participantRows = await db.all<{
      conversation_id: string;
      id: string;
      email: string;
      name: string | null;
    }>(sql`
      SELECT DISTINCT e.conversation_id, s.id, s.email, s.name
      FROM ${emails} e
      JOIN ${people} s ON s.id = e.person_id
      WHERE e.conversation_id IN ${ids}
      UNION
      SELECT DISTINCT se.conversation_id, s.id, s.email, s.name
      FROM ${sentEmails} se
      JOIN ${people} s ON s.id = se.person_id
      WHERE se.conversation_id IN ${ids} AND se.person_id IS NOT NULL
    `);
    const participantsByConv = new Map<
      string,
      Array<{ id: string; email: string; name: string | null }>
    >();
    for (const r of participantRows) {
      const list = participantsByConv.get(r.conversation_id) ?? [];
      // Dedupe by id (UNION at SQL level can still produce dupes across the
      // two branches because the joins differ).
      if (!list.some((p) => p.id === r.id)) {
        list.push({ id: r.id, email: r.email, name: r.name });
      }
      participantsByConv.set(r.conversation_id, list);
    }

    // CC participants — pull `cc` JSON from both emails + sent_emails rows in
    // each conversation, parse, dedupe by lowercased email. Skip parse errors.
    const ccRows = await db.all<{
      conversation_id: string;
      cc: string | null;
    }>(sql`
      SELECT conversation_id, cc FROM ${emails}
      WHERE conversation_id IN ${ids} AND cc IS NOT NULL
      UNION ALL
      SELECT conversation_id, cc FROM ${sentEmails}
      WHERE conversation_id IN ${ids} AND cc IS NOT NULL
    `);
    const ccByConv = new Map<
      string,
      Map<string, { email: string; name: string | null }>
    >();
    for (const r of ccRows) {
      if (!r.cc) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(r.cc);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      let map = ccByConv.get(r.conversation_id);
      if (!map) {
        map = new Map();
        ccByConv.set(r.conversation_id, map);
      }
      for (const entry of parsed) {
        if (!entry || typeof entry.email !== "string") continue;
        const key = entry.email.toLowerCase();
        if (!map.has(key)) {
          map.set(key, {
            email: entry.email,
            name: typeof entry.name === "string" ? entry.name : null,
          });
        }
      }
    }

    // Sender-side exclusion: if a participant also appears in CC, drop the CC
    // entry — they're already represented as a participant.
    groupRows = groupRowsRaw.map((r) => {
      const participants = participantsByConv.get(r.conversation_id) ?? [];
      const senderEmails = new Set(
        participants.map((p) => p.email.toLowerCase()),
      );
      const ccMap = ccByConv.get(r.conversation_id);
      const ccParticipants = ccMap
        ? Array.from(ccMap.values()).filter(
            (cc) => !senderEmails.has(cc.email.toLowerCase()),
          )
        : [];
      return {
        type: "group" as const,
        id: r.conversation_id,
        inbox: r.inbox,
        participants,
        ccParticipants,
        lastEmailAt: r.lastEmailAt,
        unreadCount: r.unreadCount,
        totalCount: r.totalCount,
        hasAttachment: r.hasAttachment,
      };
    });
  }

  // Merge persons + groups, sort, paginate. Recency is the secondary
  // tiebreaker (most-recent first) for every sort except recency itself
  // — the user's mental model is "newest first within the bucket".
  // Direction flips only the *primary* key; the recency tiebreaker
  // stays desc so newer items always come up first within a tie.
  type Row = (typeof personRows)[number] | (typeof groupRows)[number];
  const inboxOf = (r: Row): string =>
    r.type === "person" ? (r.recipients[0] ?? "") : r.inbox;
  const merged: Row[] = [...personRows, ...groupRows];
  const sign = effectiveDirection === "asc" ? -1 : 1;
  switch (sort) {
    case "unread":
      merged.sort(
        (a, b) =>
          sign * (b.unreadCount - a.unreadCount) ||
          b.lastEmailAt - a.lastEmailAt,
      );
      break;
    case "inbox":
      merged.sort((a, b) => {
        const ia = inboxOf(a).toLowerCase();
        const ib = inboxOf(b).toLowerCase();
        if (ia !== ib) return -sign * ia.localeCompare(ib);
        return b.lastEmailAt - a.lastEmailAt;
      });
      break;
    case "attachments":
      merged.sort(
        (a, b) =>
          sign * (b.hasAttachment - a.hasAttachment) ||
          b.lastEmailAt - a.lastEmailAt,
      );
      break;
    case "recency":
    default:
      merged.sort((a, b) => sign * (b.lastEmailAt - a.lastEmailAt));
      break;
  }
  const total = merged.length;
  // Aggregate stats over the FILTERED set (not just the page). The
  // table view's stat tiles read these so they don't lie when the
  // result spans multiple pages.
  let unreadRowCount = 0;
  let attachmentRowCount = 0;
  let multiInboxRowCount = 0;
  let totalUnreadEmails = 0;
  for (const r of merged) {
    if (r.unreadCount > 0) unreadRowCount++;
    if (r.hasAttachment === 1) attachmentRowCount++;
    if (r.type === "person" && r.recipientCount > 1) multiInboxRowCount++;
    totalUnreadEmails += r.unreadCount;
  }
  const data = merged.slice(offset, offset + limit);

  return c.json(
    {
      data,
      total,
      page,
      limit,
      aggregates: {
        unreadRowCount,
        attachmentRowCount,
        multiInboxRowCount,
        totalUnreadEmails,
      },
    },
    200,
  );
});

const listPeopleRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["People"],
  description: "List people sorted by most recent email.",
  request: {
    query: z.object({
      q: z
        .string()
        .optional()
        .openapi({ description: "Search person name/email" }),
      recipient: z
        .string()
        .optional()
        .openapi({ description: "Filter by recipient address" }),
      personId: z
        .string()
        .optional()
        .openapi({ description: "Filter by person ID" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        data: z.array(PersonSchema),
        total: z.number(),
        page: z.number(),
        limit: z.number(),
      }),
      "Paginated list of people",
    ),
  },
});

peopleRouter.openapi(listPeopleRoute, async (c) => {
  const db = c.get("db");
  const { q, recipient, personId, page, limit } = c.req.valid("query");
  const offset = (page - 1) * limit;

  // Build WHERE conditions for the emails table
  const conditions: any[] = [];

  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(
      sql`(s.email LIKE ${pattern} ESCAPE '\\' OR s.name LIKE ${pattern} ESCAPE '\\')`,
    );
  }

  if (recipient) {
    conditions.push(sql`e.recipient = ${recipient}`);
  }

  if (personId) {
    conditions.push(sql`s.id = ${personId}`);
  }

  const allowed = c.get("allowedInboxes")!;
  const scopeClause = peopleScopeClause(allowed);
  const extraConditions =
    conditions.length > 0
      ? sql`AND ${sql.join(conditions, sql` AND `)}`
      : sql``;
  const whereClause = sql`WHERE 1=1 ${extraConditions} ${scopeClause}`;

  // Group by (person, recipient) to get per-thread stats
  const rows = await db.all<{
    id: string;
    email: string;
    name: string | null;
    recipient: string;
    lastEmailAt: number;
    unreadCount: number;
    totalCount: number;
    latestSubject: string | null;
  }>(sql`
    SELECT
      s.id,
      s.email,
      s.name,
      e.recipient,
      MAX(e.received_at) AS lastEmailAt,
      SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) AS unreadCount,
      COUNT(*) AS totalCount,
      (
        SELECT e2.subject FROM emails e2
        WHERE e2.person_id = s.id AND e2.recipient = e.recipient
        ORDER BY e2.received_at DESC LIMIT 1
      ) AS latestSubject
    FROM ${emails} e
    JOIN ${people} s ON s.id = e.person_id
    ${whereClause}
    GROUP BY s.id, e.recipient
    ORDER BY lastEmailAt DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  // Get total count of (person, recipient) pairs
  const countResult = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM ${emails} e
      JOIN ${people} s ON s.id = e.person_id
      ${whereClause}
      GROUP BY s.id, e.recipient
    )
  `);
  const total = countResult[0]?.count ?? 0;

  return c.json({ data: rows, total, page, limit }, 200);
});

const getPersonRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["People"],
  description: "Get person detail.",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    ...json200Response(PersonSchema, "Person detail"),
  },
});

peopleRouter.openapi(getPersonRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const rows = await db.select().from(people).where(eq(people.id, id)).limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Person not found" }, 404);
  }

  const allowed = c.get("allowedInboxes")!;
  if (!allowed.isAdmin) {
    if (allowed.inboxes.length === 0) {
      return c.json({ error: "Person not found" }, 404);
    }
    const match = await db
      .select({ id: emails.id })
      .from(emails)
      .where(
        and(
          eq(emails.personId, id),
          inArray(emails.recipient, allowed.inboxes),
        ),
      )
      .limit(1);
    if (match.length === 0) {
      return c.json({ error: "Person not found" }, 404);
    }
  }

  return c.json(rows[0], 200);
});

const deletePersonRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["People"],
  description:
    "Hard delete a person and all their received emails, sent emails, and R2 attachments.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Person deleted" },
    403: { description: "Forbidden" },
    404: { description: "Person not found" },
  },
});

peopleRouter.openapi(deletePersonRoute, async (c) => {
  const db = c.get("db");
  const r2 = c.env.R2;
  const { id } = c.req.valid("param");
  const allowed = c.get("allowedInboxes")!;

  if (!allowed.isAdmin) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const person = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.id, id))
    .limit(1);

  if (person.length === 0) {
    return c.json({ error: "Person not found" }, 404);
  }

  // Delete R2 attachments for all received emails belonging to this person
  const atts = await db
    .select({ r2Key: attachments.r2Key })
    .from(attachments)
    .innerJoin(emails, eq(attachments.emailId, emails.id))
    .where(eq(emails.personId, id));

  for (const att of atts) {
    await r2.delete(att.r2Key);
  }

  await db
    .delete(attachments)
    .where(
      inArray(
        attachments.emailId,
        db
          .select({ id: emails.id })
          .from(emails)
          .where(eq(emails.personId, id)),
      ),
    );
  await db.delete(emails).where(eq(emails.personId, id));
  await db.delete(sentEmails).where(eq(sentEmails.personId, id));
  await db.delete(people).where(eq(people.id, id));

  return c.json({ success: true }, 200);
});

// Bulk mark all unread emails as read for one or more people. Optionally
// scope to a specific inbox (e.g. mark only `support@` traffic as read).
const bulkMarkReadRoute = createRoute({
  method: "post",
  path: "/mark-read",
  tags: ["People"],
  description: "Mark every unread email for the given people as read.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            personIds: z.array(z.string()).min(1),
            recipient: z.string().optional().openapi({
              description:
                "Optional: scope the mark-read to one inbox address.",
            }),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(
      z.object({
        success: z.boolean(),
        affected: z.number(),
      }),
      "Marked unread emails as read",
    ),
  },
});

peopleRouter.openapi(bulkMarkReadRoute, async (c) => {
  const db = c.get("db");
  const { personIds, recipient } = c.req.valid("json");
  const allowed = c.get("allowedInboxes")!;

  if (personIds.length === 0) {
    return c.json({ success: true, affected: 0 }, 200);
  }

  // Build the recipient scope (admin sees all; member is gated by permitted
  // inboxes; explicit `recipient` narrows further).
  const recipientScope = (() => {
    if (recipient) {
      if (!allowed.isAdmin && !allowed.inboxes.includes(recipient)) {
        return null; // not permitted
      }
      return [recipient];
    }
    if (allowed.isAdmin) return null; // no scope needed
    if (allowed.inboxes.length === 0) return [];
    return allowed.inboxes;
  })();

  if (recipientScope && recipientScope.length === 0) {
    return c.json({ success: true, affected: 0 }, 200);
  }

  // Update emails. We compute the affected count via a SELECT first so we
  // can return a useful number to the UI.
  const conditions = [
    inArray(emails.personId, personIds),
    eq(emails.isRead, 0),
  ];
  if (recipientScope) {
    conditions.push(inArray(emails.recipient, recipientScope));
  }
  const where = and(...conditions)!;

  const affectedRows = await db
    .select({ id: emails.id, personId: emails.personId })
    .from(emails)
    .where(where);
  const affected = affectedRows.length;

  if (affected > 0) {
    await db.update(emails).set({ isRead: 1 }).where(where);

    // Recompute unread_count for each touched person from source-of-truth.
    const touchedPersonIds = Array.from(
      new Set(affectedRows.map((r) => r.personId).filter(Boolean) as string[]),
    );
    for (const pid of touchedPersonIds) {
      const [row] = await db.all<{ count: number }>(sql`
        SELECT COUNT(*) AS count FROM ${emails}
        WHERE person_id = ${pid} AND is_read = 0
      `);
      await db
        .update(people)
        .set({ unreadCount: row?.count ?? 0 })
        .where(eq(people.id, pid));
    }
  }

  return c.json({ success: true, affected }, 200);
});
