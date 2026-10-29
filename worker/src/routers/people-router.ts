import { auditMailDeleted } from "../lib/audit/mail-events";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { desc, like, or, eq, sql, and, inArray, isNotNull } from "drizzle-orm";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { attachments } from "../db/attachments.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { drafts } from "../db/drafts.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { categoryOverrides } from "../db/mail-item-states.schema";
import { userPreferences } from "../db/user-preferences.schema";
import { json200Response, escapeLike, escapeFts } from "../lib/helpers";
import {
  getPersonScoped,
  listPeople,
  peopleScopeClause,
} from "../lib/queries/people";
import type { Variables } from "../variables";
import {
  inboxScopeSql,
  isInboxAllowed,
  jsonList,
} from "../lib/inbox-permissions";
import { deleteMessageState, deletePersonRowPins } from "../lib/messages/state";
import { buildMessageQuerySql } from "../lib/messages/query";
import {
  markSeenForViewer,
  rowKey,
  rowMailState,
} from "../lib/messages/row-state";
import { cancelScheduledSendsFor } from "../lib/scheduled-sends";
import {
  collectPersonGroupConversations,
  deletePersonConversationState,
} from "../lib/messages/conversation-state";
import { cleanupCustomerForPersonDeletion } from "../lib/customers";

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
  linkedCount: z.number(),
  // The row's mail state (star and pin are the caller's own; archive, snooze
  // and trash are shared per inbox, docs/mailbox-state.md) plus what the
  // Gmail and Outlook layouts need to draw a row: last subject, a snippet and
  // whether we have ever written to this thread.
  starred: z.boolean(),
  pinned: z.boolean(),
  archivedAt: z.number().nullable(),
  snoozedUntil: z.number().nullable(),
  trashedAt: z.number().nullable(),
  hasSent: z.boolean(),
  latestSubject: z.string().nullable(),
  snippet: z.string().nullable(),
  /** Gmail-style category, from headers and sender (see categorize). */
  category: z.enum(["primary", "promotions", "social", "updates"]),
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
  // The row's mail state (star and pin are the caller's own; archive, snooze
  // and trash are shared per inbox, docs/mailbox-state.md) plus what the
  // Gmail and Outlook layouts need to draw a row: last subject, a snippet and
  // whether we have ever written to this thread.
  starred: z.boolean(),
  pinned: z.boolean(),
  archivedAt: z.number().nullable(),
  snoozedUntil: z.number().nullable(),
  trashedAt: z.number().nullable(),
  hasSent: z.boolean(),
  latestSubject: z.string().nullable(),
  snippet: z.string().nullable(),
  /** Gmail-style category, from headers and sender (see categorize). */
  category: z.enum(["primary", "promotions", "social", "updates"]),
});

const GroupedItemSchema = z.discriminatedUnion("type", [
  GroupedPersonSchema,
  GroupedConversationSchema,
]);

const EMPTY_ROW_STATE = {
  starred: false,
  pinned: false,
  archivedAt: null as number | null,
  snoozedUntil: null as number | null,
  trashedAt: null as number | null,
  hasSent: false,
  latestSubject: null as string | null,
  snippet: null as string | null,
  category: "primary" as MailCategory,
};

type MailCategory = "primary" | "promotions" | "social" | "updates";

const SOCIAL_DOMAINS = [
  "facebook.com",
  "facebookmail.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "redditmail.com",
  "pinterest.com",
  "youtube.com",
  "discord.com",
  "slack.com",
  "meetup.com",
];
const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|notifications?|alerts?|updates?|mailer(-daemon)?|bounce[s]?|billing|receipts?|invoices?|support-noreply|accounts?|security|system|automated|bot)([+._-].*)?$/i;

/**
 * Gmail-style tab for a row. Bulk mail (a List-Unsubscribe header) is
 * Promotions, social networks are Social, automated senders are Updates,
 * and everything else — real people — is Primary.
 */
const BULK_INBOX_LOCAL =
  /^(newsletters?|marketing|promo(tions)?|news|digest)$/i;
const UPDATES_INBOX_LOCAL =
  /^(notifications?|alerts?|billing|receipts?|invoices?|status|system|no-?reply)$/i;

export function categorize(
  senderEmails: string[],
  hasListUnsubscribe: boolean,
  /** Our inboxes the row's mail went to; a row only ever seen by a
   *  newsletter@ or notifications@ style inbox follows that inbox. */
  inboxes: string[] = [],
): MailCategory {
  const domains = senderEmails.map((e) =>
    e.slice(e.lastIndexOf("@") + 1).toLowerCase(),
  );
  if (
    domains.some((d) =>
      SOCIAL_DOMAINS.some((s) => d === s || d.endsWith(`.${s}`)),
    )
  )
    return "social";
  if (hasListUnsubscribe) return "promotions";
  if (senderEmails.some((e) => AUTOMATED_LOCAL.test(e.split("@")[0] ?? "")))
    return "updates";
  const locals = inboxes.map((i) => i.split("@")[0] ?? "");
  if (locals.length > 0 && locals.every((l) => BULK_INBOX_LOCAL.test(l)))
    return "promotions";
  if (locals.length > 0 && locals.every((l) => UPDATES_INBOX_LOCAL.test(l)))
    return "updates";
  return "primary";
}

export const GroupedQuerySchema = z.object({
  q: z.string().optional().openapi({ description: "Search person name/email" }),
  recipient: z.string().optional().openapi({
    description: "Filter to people who have emailed this inbox address",
  }),
  unread: z
    .enum(["1", "true"])
    .optional()
    .openapi({ description: "Only people with unread emails" }),
  drafts: z.enum(["1", "true"]).optional().openapi({
    description:
      "Only conversations where the current user has a reply or forward draft",
  }),
  sequenced: z.enum(["1", "true"]).optional().openapi({
    description: "Only contacts currently enrolled in a sequence (active)",
  }),
  hasAttachment: z.enum(["1", "true"]).optional().openapi({
    description: "Only rows with a (non-inline) attachment",
  }),
  from: z.string().optional().openapi({
    description:
      "Only rows whose sender (person, or a group participant) matches this name or address",
  }),
  category: z
    .enum(["primary", "promotions", "social", "updates"])
    .optional()
    .openapi({ description: "Gmail-style category tab" }),
  starred: z.enum(["1", "true"]).optional().openapi({
    description: "Only rows the caller starred (Outlook: flagged)",
  }),
  pinned: z
    .enum(["1", "true"])
    .optional()
    .openapi({ description: "Only rows the caller pinned" }),
  after: z.coerce.number().int().optional().openapi({
    description: "Only rows with activity at or after this unix second",
  }),
  before: z.coerce.number().int().optional().openapi({
    description: "Only rows whose latest activity is before this unix second",
  }),
  subject: z.string().optional().openapi({
    description: "Only rows with a message whose subject contains this",
  }),
  withTabCounts: z.enum(["1", "true"]).optional().openapi({
    description:
      "Also return per-category unread and new-since-last-viewed counts for the inbox",
  }),
  folder: z
    .enum(["all", "inbox", "starred", "snoozed", "archive", "sent", "trash"])
    .optional()
    .default("all")
    .openapi({
      description:
        "Mail folder, from the rows' message state (docs/mailbox-state.md § Rows in the inbox list). `all` (default) keeps rows with untrashed mail; `inbox` keeps rows with mail in the Inbox that is not snoozed and puts the caller's pinned rows first; `snoozed` orders by wake time; `sent` keeps rows we have written to; every folder except `trash` hides trashed rows. Spam never puts a row in a folder.",
    }),
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
  // Cap at 100 so post-pagination group hydration stays under D1's
  // 100 bound-parameter limit (one `IN (...)` of page ids).
  limit: z.coerce.number().min(1).max(100).optional().default(50),
});

const listGroupedPeopleRoute = createRoute({
  method: "get",
  path: "/grouped",
  tags: ["People"],
  description:
    "List people and group conversations together (sorted by most recent activity).",
  request: {
    query: GroupedQuerySchema,
  },
  responses: {
    ...json200Response(
      z.object({
        data: z.array(GroupedItemSchema),
        /** Present when `withTabCounts` is set. */
        tabCounts: z
          .record(z.string(), z.object({ unread: z.number(), new: z.number() }))
          .nullable()
          .optional(),
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

export type GroupedQuery = z.infer<typeof GroupedQuerySchema>;

/**
 * Every grouped row matching the query, with the caller's state applied,
 * filtered and sorted — before paging. Shared by the list, the id listing
 * (bulk actions over a whole folder) and the tab counts.
 */
export async function computeGroupedRows(
  c: Context<{ Bindings: CloudflareBindings; Variables: Variables }>,
  query: GroupedQuery,
  opts: {
    /** Skip the Gmail-style categories (two scans of raw_headers) when the
     *  caller neither filters by nor shows them, like the stats counts. */
    categories?: boolean;
  } = {},
) {
  const needCategories =
    opts.categories !== false || !!query.category || !!query.withTabCounts;
  const db = c.get("db");
  const user = c.get("user");
  const {
    q,
    recipient,
    unread,
    drafts: draftsOnly,
    sequenced,
    hasAttachment: attachmentsOnly,
    from,
    category,
    folder,
    sort,
    direction,
    starred: starredOnly,
    pinned: pinnedOnly,
    after,
    before,
    subject,
  } = query;
  // Scope the drafts filter to the signed-in user. Empty id matches no
  // drafts, so the filter safely yields nothing if the user is somehow absent.
  const draftsUserId = user?.id ?? "";
  // The email a draft hangs off: a reply (`reply:<emailId>`, which also
  // stores reply_to_email_id) or a forward (`forward:<emailId>`, which does
  // not). The new-message `compose` draft maps to nothing, so it never
  // surfaces a row.
  const draftTargetEmailId = sql`(CASE
    WHEN d.context_key LIKE 'reply:%'
      THEN COALESCE(d.reply_to_email_id, substr(d.context_key, 7))
    WHEN d.context_key LIKE 'forward:%'
      THEN substr(d.context_key, 9)
  END)`;
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
      sql`s.id IN (SELECT person_id FROM emails WHERE recipient = ${recipient} AND conversation_id IS NULL ${inboxScopeSql(allowed, sql`recipient`)})`,
    );
  }
  if (sequenced) {
    personConditions.push(
      sql`s.id IN (SELECT person_id FROM ${sequenceEnrollments} WHERE status = 'active')`,
    );
  }
  if (draftsOnly) {
    personConditions.push(
      sql`s.id IN (
        SELECT e.person_id FROM emails e
        JOIN ${drafts} d ON e.id = ${draftTargetEmailId}
        WHERE d.user_id = ${draftsUserId}
          AND e.conversation_id IS NULL
          ${inboxScopeSql(allowed, sql`e.recipient`)}
      )`,
    );
  }
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    const ftsQuery = escapeFts(q);
    const ftsInboxScope = allowed.isAdmin
      ? sql``
      : allowed.inboxes.length === 0
        ? sql`AND 0`
        : sql`AND emails.recipient IN ${jsonList(allowed.inboxes)}`;
    personConditions.push(
      sql`(s.email LIKE ${pattern} ESCAPE '\\' OR s.name LIKE ${pattern} ESCAPE '\\'
        OR s.id IN (
          SELECT person_id FROM emails
          JOIN emails_fts ON emails.rowid = emails_fts.rowid
          WHERE emails_fts MATCH ${ftsQuery} ${ftsInboxScope} AND emails.conversation_id IS NULL
        ))`,
    );
  }
  if (from) {
    const pattern = `%${escapeLike(from)}%`;
    personConditions.push(
      sql`(s.email LIKE ${pattern} ESCAPE '\\' OR s.name LIKE ${pattern} ESCAPE '\\')`,
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
  const linkedPeopleScope = allowed.isAdmin
    ? sql``
    : allowed.inboxes.length === 0
      ? sql`AND 0`
      : sql`AND cp2.person_id IN (
          SELECT person_id FROM ${emails} WHERE recipient IN ${jsonList(allowed.inboxes)}
          UNION
          SELECT person_id FROM ${sentEmails}
          WHERE from_address IN ${jsonList(allowed.inboxes)} AND person_id IS NOT NULL
        )`;

  // Aggregate over both received and sent emails so people we've composed to
  // appear in the list, not just senders who have emailed us. We exclude
  // any rows with a non-null conversation_id — those belong under group rows.
  // Both arms are scoped to the caller's inboxes: `peopleScopeClause` decides
  // which people are listed, this decides which of their mail is counted, so
  // a sender who also wrote to a private inbox shows none of that inbox's
  // address, counts or recency.
  const activity = sql`(
    SELECT person_id, recipient AS inbox, received_at AS at, is_read, conversation_id, 0 AS is_sent
    FROM ${emails}
    WHERE 1=1 ${inboxScopeSql(allowed, sql`recipient`)}
    UNION ALL
    SELECT person_id, from_address AS inbox, sent_at AS at, 1 AS is_read, conversation_id, 1 AS is_sent
    FROM ${sentEmails}
    WHERE person_id IS NOT NULL ${inboxScopeSql(allowed, sql`from_address`)}
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
    linkedCount: number;
    hasSent: number;
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
      MAX(e.is_sent) AS hasSent,
      EXISTS(
        SELECT 1 FROM ${attachments} a
        JOIN ${emails} e2 ON e2.id = a.email_id
        WHERE e2.person_id = s.id
        AND a.content_id IS NULL
        AND e2.conversation_id IS NULL
        ${inboxScopeSql(allowed, sql`e2.recipient`)}
      ) AS hasAttachment,
      MAX(
        0,
        (
          SELECT COUNT(*)
          FROM customer_people cp2
          WHERE cp2.customer_id = (
            SELECT cp.customer_id
            FROM customer_people cp
            WHERE cp.person_id = s.id
            LIMIT 1
          )
          ${linkedPeopleScope}
        ) - 1
      ) AS linkedCount
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
    linkedCount: r.linkedCount,
    ...EMPTY_ROW_STATE,
    hasSent: r.hasSent === 1,
  }));

  // ----- GROUP CONVERSATION ROWS (conversation_id IS NOT NULL) -----
  // Activity-style subquery scoped to the inbox set the user can see.
  // Participants / CC are hydrated AFTER pagination — loading them for
  // every group up front doubled a large `IN (...)` list and blew D1's
  // 100-param cap once a mailbox had ~50+ group threads.
  const groupInboxScope = allowed.isAdmin
    ? sql``
    : allowed.inboxes.length === 0
      ? sql`AND 0`
      : sql`AND inbox IN ${jsonList(allowed.inboxes)}`;

  const groupConditions: any[] = [];
  if (recipient) {
    groupConditions.push(sql`g.inbox = ${recipient}`);
  }
  if (sequenced) {
    // Only individual contacts are enrolled in sequences — never group
    // conversations — so this filter excludes every group row.
    groupConditions.push(sql`0`);
  }
  if (draftsOnly) {
    groupConditions.push(
      sql`g.conversation_id IN (
        SELECT e.conversation_id FROM emails e
        JOIN ${drafts} d ON e.id = ${draftTargetEmailId}
        WHERE d.user_id = ${draftsUserId}
          AND e.conversation_id IS NOT NULL
          ${inboxScopeSql(allowed, sql`e.recipient`)}
      )`,
    );
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
        : sql`AND emails.recipient IN ${jsonList(allowed.inboxes)}`;
    groupConditions.push(sql`(
      g.conversation_id IN (
        SELECT DISTINCT e.conversation_id FROM ${emails} e
        JOIN ${people} p ON p.id = e.person_id
        WHERE e.conversation_id IS NOT NULL
        AND (p.email LIKE ${pattern} ESCAPE '\\' OR p.name LIKE ${pattern} ESCAPE '\\')
        ${inboxScopeSql(allowed, sql`e.recipient`)}
      )
      OR g.conversation_id IN (
        SELECT emails.conversation_id FROM emails
        JOIN emails_fts ON emails.rowid = emails_fts.rowid
        WHERE emails_fts MATCH ${ftsQuery} AND emails.conversation_id IS NOT NULL ${ftsInboxScope}
      )
      OR g.conversation_id IN (
        SELECT conversation_id FROM ${sentEmails}
        WHERE conversation_id IS NOT NULL AND subject LIKE ${pattern} ESCAPE '\\'
        ${inboxScopeSql(allowed, sql`from_address`)}
      )
    )`);
  }
  if (from) {
    const pattern = `%${escapeLike(from)}%`;
    groupConditions.push(sql`g.conversation_id IN (
      SELECT DISTINCT e.conversation_id FROM ${emails} e
      JOIN ${people} p ON p.id = e.person_id
      WHERE e.conversation_id IS NOT NULL
      AND (p.email LIKE ${pattern} ESCAPE '\\' OR p.name LIKE ${pattern} ESCAPE '\\')
      ${inboxScopeSql(allowed, sql`e.recipient`)}
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
    hasSent: number;
  }>(sql`
    SELECT
      g.conversation_id,
      g.inbox,
      g.lastEmailAt,
      g.unreadCount,
      g.totalCount,
      g.hasAttachment,
      g.hasSent
    FROM (
      SELECT
        conversation_id,
        inbox,
        MAX(at) AS lastEmailAt,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unreadCount,
        COUNT(*) AS totalCount,
        MAX(is_sent) AS hasSent,
        EXISTS(
          SELECT 1 FROM ${attachments} a
          JOIN ${emails} e2 ON e2.id = a.email_id
          WHERE e2.conversation_id = act.conversation_id
          AND a.content_id IS NULL
          ${inboxScopeSql(allowed, sql`e2.recipient`)}
        ) AS hasAttachment
      FROM (
        SELECT conversation_id, recipient AS inbox, received_at AS at, is_read, 0 AS is_sent
        FROM ${emails}
        WHERE conversation_id IS NOT NULL
        UNION ALL
        SELECT conversation_id, from_address AS inbox, sent_at AS at, 1 AS is_read, 1 AS is_sent
        FROM ${sentEmails}
        WHERE conversation_id IS NOT NULL
      ) act
      WHERE 1=1 ${groupInboxScope}
      GROUP BY conversation_id, inbox
    ) g
    WHERE 1=1 ${groupExtraConditions}
    ORDER BY g.lastEmailAt DESC
  `);

  // Lightweight group rows — participants/CC filled in for the page only.
  const groupRows = groupRowsRaw.map((r) => ({
    type: "group" as const,
    id: r.conversation_id,
    inbox: r.inbox,
    participants: [] as Array<{
      id: string;
      email: string;
      name: string | null;
    }>,
    ccParticipants: [] as Array<{ email: string; name: string | null }>,
    lastEmailAt: r.lastEmailAt,
    unreadCount: r.unreadCount,
    totalCount: r.totalCount,
    hasAttachment: r.hasAttachment,
    ...EMPTY_ROW_STATE,
    hasSent: r.hasSent === 1,
  }));

  // Merge persons + groups, sort, paginate. Recency is the secondary
  // tiebreaker (most-recent first) for every sort except recency itself
  // — the user's mental model is "newest first within the bucket".
  // Direction flips only the *primary* key; the recency tiebreaker
  // stays desc so newer items always come up first within a tie.
  type Row = (typeof personRows)[number] | (typeof groupRows)[number];
  const inboxOf = (r: Row): string =>
    r.type === "person" ? (r.recipients[0] ?? "") : r.inbox;
  let merged: Row[] = [...personRows, ...groupRows];

  // Star, pin, archive, snooze, trash and unread come from the per-message
  // state (docs/mailbox-state.md § Rows in the inbox list). A row with no
  // eligible (non-spam) message is in no folder.
  const rowState = await rowMailState(
    db,
    { userId: user?.id ?? "" },
    allowed,
    Math.floor(Date.now() / 1000),
  );
  merged = merged.filter((r) => rowState.has(rowKey(r)));
  for (const r of merged) {
    const st = rowState.get(rowKey(r))!;
    r.starred = st.starred;
    r.pinned = st.pinned;
    r.archivedAt = st.archivedAt;
    r.snoozedUntil = st.snoozedUntil;
    r.trashedAt = st.trashedAt;
    r.unreadCount = folder === "inbox" ? st.inboxUnreadCount : st.unreadCount;
  }
  // Categories: one query per row kind for "has bulk-mail headers", then
  // sender heuristics in categorize().
  if (needCategories) {
    const promoPeople = new Set(
      (
        await db.all<{ k: string }>(sql`
        SELECT DISTINCT person_id AS k FROM ${emails}
        WHERE conversation_id IS NULL AND lower(raw_headers) LIKE '%list-unsubscribe%'
        ${inboxScopeSql(allowed, sql`recipient`)}
      `)
      ).map((r) => r.k),
    );
    const promoConvs = new Set(
      (
        await db.all<{ k: string }>(sql`
        SELECT DISTINCT conversation_id AS k FROM ${emails}
        WHERE conversation_id IS NOT NULL AND lower(raw_headers) LIKE '%list-unsubscribe%'
        ${inboxScopeSql(allowed, sql`recipient`)}
      `)
      ).map((r) => r.k),
    );
    for (const r of merged) {
      r.category =
        r.type === "person"
          ? categorize([r.email], promoPeople.has(r.id), r.recipients)
          : // Group senders are hydrated after paging; headers and the
            // inbox decide.
            categorize([], promoConvs.has(r.id), [r.inbox]);
    }
    // The caller's own "Move to <tab>" corrections win over the guess.
    const overrides = await db
      .select()
      .from(categoryOverrides)
      .where(eq(categoryOverrides.userId, user?.id ?? ""));
    if (overrides.length > 0) {
      const bySender = new Map(
        overrides.map((o: any) => [o.senderEmail, o.category as MailCategory]),
      );
      for (const r of merged) {
        if (r.type !== "person") continue;
        const o = bySender.get(r.email.toLowerCase());
        if (o) r.category = o;
      }
    }
  }

  // Inbox tab counts: unread rows per category, and how many of those
  // arrived since the caller last opened that tab.
  let tabCounts: Record<MailCategory, { unread: number; new: number }> | null =
    null;
  if (query.withTabCounts) {
    const [pref] = await db
      .select({ tabSeen: userPreferences.tabSeen })
      .from(userPreferences)
      .where(eq(userPreferences.userId, user?.id ?? ""))
      .limit(1);
    let seen: Record<string, number> = {};
    try {
      seen = pref?.tabSeen ? JSON.parse(pref.tabSeen) : {};
    } catch {
      seen = {};
    }
    tabCounts = {
      primary: { unread: 0, new: 0 },
      promotions: { unread: 0, new: 0 },
      social: { unread: 0, new: 0 },
      updates: { unread: 0, new: 0 },
    };
    for (const r of merged) {
      const st = rowState.get(rowKey(r))!;
      if (!st.inInbox || st.inboxUnreadCount <= 0) continue;
      const t = tabCounts[r.category];
      t.unread++;
      if (r.lastEmailAt > (seen[r.category] ?? 0)) t.new++;
    }
  }

  if (category) merged = merged.filter((r) => r.category === category);
  if (attachmentsOnly) merged = merged.filter((r) => r.hasAttachment === 1);
  if (starredOnly) merged = merged.filter((r) => r.starred);
  if (pinnedOnly) merged = merged.filter((r) => r.pinned);
  if (after !== undefined)
    merged = merged.filter((r) => r.lastEmailAt >= after);
  if (before !== undefined)
    merged = merged.filter((r) => r.lastEmailAt < before);
  const subjectSearch = subject?.trim();
  if (subjectSearch) {
    // Subject hits come from the shared message query (AGENTS.md § Message
    // reads), scoped to the caller's inboxes like the rows themselves.
    const built = buildMessageQuerySql(allowed, {
      search: subjectSearch,
      searchMode: "subject",
      limit: null,
    });
    const hits = built
      ? await db.all<{
          person_id: string | null;
          conversation_id: string | null;
        }>(
          sql`SELECT DISTINCT person_id, conversation_id FROM (${built.statement})`,
        )
      : [];
    const personHits = new Set<string>();
    const convHits = new Set<string>();
    for (const h of hits) {
      if (h.conversation_id) convHits.add(h.conversation_id);
      else if (h.person_id) personHits.add(h.person_id);
    }
    merged = merged.filter((r) =>
      r.type === "person" ? personHits.has(r.id) : convHits.has(r.id),
    );
  }
  // Trash hides a row everywhere except the Trash folder.
  if (folder !== "trash") merged = merged.filter((r) => !r.trashedAt);
  switch (folder) {
    case "inbox":
      merged = merged.filter((r) => rowState.get(rowKey(r))!.inInbox);
      break;
    case "starred":
      merged = merged.filter((r) => r.starred);
      break;
    case "snoozed":
      merged = merged.filter((r) => r.snoozedUntil);
      break;
    case "archive":
      merged = merged.filter((r) => r.archivedAt);
      break;
    case "sent":
      merged = merged.filter((r) => r.hasSent);
      break;
    case "trash":
      merged = merged.filter((r) => r.trashedAt);
      break;
  }
  if (unread) merged = merged.filter((r) => r.unreadCount > 0);

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
  if (folder === "inbox") {
    // Stable sort keeps the chosen order within the pinned and unpinned sets.
    merged.sort((a, b) => Number(b.pinned) - Number(a.pinned));
  } else if (folder === "snoozed") {
    merged.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  }
  return { merged, tabCounts };
}

peopleRouter.openapi(listGroupedPeopleRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const query = c.req.valid("query");
  const { page, limit } = query;
  const offset = (page - 1) * limit;
  const { merged, tabCounts } = await computeGroupedRows(c, query);
  type Row = (typeof merged)[number];
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

  // Latest subject and a short snippet for each row on this page, for the
  // Gmail and Outlook list layouts. One query per row kind, each binding the
  // page ids once (limit <= 100 keeps us under D1's parameter cap).
  const pagePersonIds = data
    .filter((r) => r.type === "person")
    .map((r) => r.id);
  const pageConvIds = data.filter((r) => r.type === "group").map((r) => r.id);
  // Each table is queried on its own so the page ids are bound once per
  // statement; the newer of the two rows wins.
  type Latest = { subject: string | null; body: string | null; at: number };
  const latestFor = async (
    column: "person_id" | "conversation_id",
    ids: string[],
  ) => {
    const out = new Map<string, Latest>();
    if (ids.length === 0) return out;
    const keyCol = sql.raw(column);
    const onlyOneToOne =
      column === "person_id" ? sql`AND conversation_id IS NULL` : sql``;
    // Only messages in the caller's inboxes: a row they may see can also
    // have mail in an inbox they may not.
    for (const [table, atCol, inboxCol] of [
      [emails, sql.raw("received_at"), sql.raw("recipient")],
      [sentEmails, sql.raw("sent_at"), sql.raw("from_address")],
    ] as const) {
      const rows = await db.all<Latest & { k: string }>(sql`
        SELECT k, subject, body, at FROM (
          SELECT ${keyCol} AS k, subject, substr(body_text, 1, 400) AS body,
            ${atCol} AS at,
            ROW_NUMBER() OVER (PARTITION BY ${keyCol} ORDER BY ${atCol} DESC) AS rn
          FROM ${table} WHERE ${keyCol} IN ${jsonList(ids)} ${onlyOneToOne}
            ${inboxScopeSql(allowed, inboxCol)}
        ) WHERE rn = 1
      `);
      for (const r of rows) {
        const prev = out.get(r.k);
        if (!prev || r.at > prev.at) out.set(r.k, r);
      }
    }
    return out;
  };
  const latestByPerson = await latestFor("person_id", pagePersonIds);
  const latestByConv = await latestFor("conversation_id", pageConvIds);
  for (const row of data) {
    const latest =
      row.type === "person"
        ? latestByPerson.get(row.id)
        : latestByConv.get(row.id);
    if (!latest) continue;
    row.latestSubject = latest.subject;
    row.snippet = latest.body
      ? latest.body.replace(/\s+/g, " ").trim().slice(0, 200)
      : null;
  }

  // Hydrate participants + CC only for group rows on this page.
  // Limit is capped at 100; each follow-up binds the page ids once (split
  // queries, not a UNION of two identical IN lists).
  const pageGroupIds = data
    .filter((r): r is Extract<Row, { type: "group" }> => r.type === "group")
    .map((r) => r.id);
  if (pageGroupIds.length > 0) {
    const fromInboxParticipants = await db.all<{
      conversation_id: string;
      id: string;
      email: string;
      name: string | null;
    }>(sql`
      SELECT DISTINCT e.conversation_id, s.id, s.email, s.name
      FROM ${emails} e
      JOIN ${people} s ON s.id = e.person_id
      WHERE e.conversation_id IN ${jsonList(pageGroupIds)}
        ${inboxScopeSql(allowed, sql`e.recipient`)}
    `);
    const fromSentParticipants = await db.all<{
      conversation_id: string;
      id: string;
      email: string;
      name: string | null;
    }>(sql`
      SELECT DISTINCT se.conversation_id, s.id, s.email, s.name
      FROM ${sentEmails} se
      JOIN ${people} s ON s.id = se.person_id
      WHERE se.conversation_id IN ${jsonList(pageGroupIds)} AND se.person_id IS NOT NULL
        ${inboxScopeSql(allowed, sql`se.from_address`)}
    `);
    const participantsByConv = new Map<
      string,
      Array<{ id: string; email: string; name: string | null }>
    >();
    for (const r of [...fromInboxParticipants, ...fromSentParticipants]) {
      const list = participantsByConv.get(r.conversation_id) ?? [];
      if (!list.some((p) => p.id === r.id)) {
        list.push({ id: r.id, email: r.email, name: r.name });
      }
      participantsByConv.set(r.conversation_id, list);
    }

    const fromInboxCc = await db.all<{
      conversation_id: string;
      cc: string | null;
    }>(sql`
      SELECT conversation_id, cc FROM ${emails}
      WHERE conversation_id IN ${jsonList(pageGroupIds)} AND cc IS NOT NULL
        ${inboxScopeSql(allowed, sql`recipient`)}
    `);
    const fromSentCc = await db.all<{
      conversation_id: string;
      cc: string | null;
    }>(sql`
      SELECT conversation_id, cc FROM ${sentEmails}
      WHERE conversation_id IN ${jsonList(pageGroupIds)} AND cc IS NOT NULL
        ${inboxScopeSql(allowed, sql`from_address`)}
    `);
    const ccByConv = new Map<
      string,
      Map<string, { email: string; name: string | null }>
    >();
    for (const r of [...fromInboxCc, ...fromSentCc]) {
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

    for (const row of data) {
      if (row.type !== "group") continue;
      const participants = participantsByConv.get(row.id) ?? [];
      const senderEmails = new Set(
        participants.map((p) => p.email.toLowerCase()),
      );
      const ccMap = ccByConv.get(row.id);
      row.participants = participants;
      row.ccParticipants = ccMap
        ? Array.from(ccMap.values()).filter(
            (cc) => !senderEmails.has(cc.email.toLowerCase()),
          )
        : [];
    }
  }

  return c.json(
    {
      data,
      tabCounts,
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

const groupedIdsRoute = createRoute({
  method: "get",
  path: "/grouped/ids",
  tags: ["People"],
  description:
    "Every row matching the same filters as /grouped, as `{type, id, unread, pinned}` refs (capped at 5000). Lets a client act on a whole folder — mark all read, archive all — without paging through it; `pinned` lets it undo a pin-all exactly.",
  request: { query: GroupedQuerySchema },
  responses: {
    ...json200Response(
      z.object({
        data: z.array(
          z.object({
            type: z.enum(["person", "group"]),
            id: z.string(),
            unread: z.boolean(),
            pinned: z.boolean(),
          }),
        ),
        total: z.number(),
        truncated: z.boolean(),
      }),
      "Row refs",
    ),
  },
});

peopleRouter.openapi(groupedIdsRoute, async (c) => {
  const { merged } = await computeGroupedRows(c, c.req.valid("query"));
  const CAP = 5000;
  return c.json(
    {
      data: merged.slice(0, CAP).map((r) => ({
        type: r.type,
        id: r.id,
        unread: r.unreadCount > 0,
        pinned: r.pinned,
      })),
      total: merged.length,
      truncated: merged.length > CAP,
    },
    200,
  );
});

const categoryOverrideRoute = createRoute({
  method: "put",
  path: "/category",
  tags: ["People"],
  description:
    'Move senders to a Gmail-style tab for the signed-in user ("Move to Primary"). `category: null` removes the correction.',
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            senders: z.array(z.string().email()).min(1).max(100),
            category: z
              .enum(["primary", "promotions", "social", "updates"])
              .nullable(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Saved"),
  },
});

peopleRouter.openapi(categoryOverrideRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { senders, category } = c.req.valid("json");
  const keys = [...new Set(senders.map((s) => s.toLowerCase()))];
  if (category === null) {
    await db.delete(categoryOverrides).where(
      and(
        eq(categoryOverrides.userId, user.id),
        // One bound JSON array, not one parameter per key (D1 caps a
        // statement at 100 bound parameters).
        sql`${categoryOverrides.senderEmail} IN ${jsonList(keys)}`,
      ),
    );
  } else {
    const now = Math.floor(Date.now() / 1000);
    await db.batch(
      keys.map((senderEmail) =>
        db
          .insert(categoryOverrides)
          .values({ userId: user.id, senderEmail, category, updatedAt: now })
          .onConflictDoUpdate({
            target: [categoryOverrides.userId, categoryOverrides.senderEmail],
            set: { category, updatedAt: now },
          }),
      ) as any,
    );
  }
  return c.json({ success: true }, 200);
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
  const allowed = c.get("allowedInboxes")!;

  const result = await listPeople(
    db,
    { q, recipient, personId, page, limit },
    allowed,
  );

  return c.json(result, 200);
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

  const allowed = c.get("allowedInboxes")!;
  const person = await getPersonScoped(db, id, allowed);

  if (!person) {
    return c.json({ error: "Person not found" }, 404);
  }

  return c.json(person, 200);
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
    .select({ id: people.id, email: people.email })
    .from(people)
    .where(eq(people.id, id))
    .limit(1);

  if (person.length === 0) {
    return c.json({ error: "Person not found" }, 404);
  }

  const groupConversations = await collectPersonGroupConversations(db, id);

  const received = await db
    .select({ id: emails.id, inbox: emails.recipient })
    .from(emails)
    .where(eq(emails.personId, id));
  const sent = await db
    .select({ id: sentEmails.id, inbox: sentEmails.fromAddress })
    .from(sentEmails)
    .where(eq(sentEmails.personId, id));

  await deleteMessageState(db, [
    ...received.map((message) => ({
      kind: "received" as const,
      id: message.id,
    })),
    ...sent.map((message) => ({ kind: "sent" as const, id: message.id })),
  ]);
  await deletePersonRowPins(db, id);

  // Delete R2 attachments for all received emails belonging to this person
  const atts = await db
    .select({ r2Key: attachments.r2Key })
    .from(attachments)
    .innerJoin(emails, eq(attachments.emailId, emails.id))
    .where(eq(emails.personId, id));

  for (const att of atts) {
    await r2.delete(att.r2Key);
  }
  // And each received message's raw copy (JMAP blobId).
  const raws = await db
    .select({ r2Key: emails.rawR2Key })
    .from(emails)
    .where(and(eq(emails.personId, id), isNotNull(emails.rawR2Key)));
  for (const raw of raws) {
    await r2.delete(raw.r2Key!);
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
  await cancelScheduledSendsFor(db, sql`person_id = ${id}`);
  await db.delete(sentEmails).where(eq(sentEmails.personId, id));
  await cleanupCustomerForPersonDeletion(db, id);
  await deletePersonConversationState(db, id, groupConversations);
  await db.delete(people).where(eq(people.id, id));

  // One row per inbox, so a search of an inbox's log finds what left it.
  await auditMailDeleted(
    db,
    [
      ...received.map((message) => ({
        ref: { kind: "received" as const, id: message.id },
        inbox: message.inbox,
      })),
      ...sent.map((message) => ({
        ref: { kind: "sent" as const, id: message.id },
        inbox: message.inbox,
      })),
    ],
    {
      with: `the contact ${person[0].email}`,
      details: { personId: id, person: person[0].email },
    },
  );

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
      // A recipient the caller can't access matches nothing (never "no
      // scope", which would reach every inbox).
      if (!isInboxAllowed(allowed, recipient)) return [];
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
    sql`${emails.personId} IN ${jsonList(personIds)}`,
    eq(emails.isRead, 0),
  ];
  if (recipientScope) {
    conditions.push(sql`${emails.recipient} IN ${jsonList(recipientScope)}`);
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
  // The inbox list reads the caller's own seen state (docs/mailbox-state.md).
  const user = c.get("user");
  if (user) {
    await markSeenForViewer(db, user.id, allowed, {
      personIds,
      ...(recipientScope ? { inboxes: recipientScope } : {}),
    });
  }

  return c.json({ success: true, affected }, 200);
});
