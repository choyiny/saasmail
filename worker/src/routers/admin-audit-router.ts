import { AUDIT_ACTIONS } from "../lib/audit/events";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { csvRow } from "../lib/csv";
import { escapeLike } from "../lib/helpers";
import type { Variables } from "../variables";

// Mounted under /api/admin, so the admin guard and the passkey gate in
// worker/src/index.ts already apply: members get 403.
export const adminAuditRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** The most rows one CSV export returns. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;
const EXPORT_PAGE = 500;

const ErrorSchema = z.object({ error: z.string() });

const AuditEventSchema = z.object({
  id: z.string(),
  at: z.number().openapi({ description: "Unix seconds." }),
  actorType: z.string().openapi({
    description: "user, api_key, mcp, jmap, agent, rule or system.",
  }),
  actorUserId: z.string().nullable(),
  actorLabel: z.string(),
  channel: z.string().openapi({
    description:
      "web, api, mcp, jmap, agent, rule, inbound, cron, queue or import.",
  }),
  action: z.string().openapi({ example: "mail.archived" }),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  inbox: z.string().nullable(),
  summary: z.string(),
  details: z.record(z.string(), z.any()).nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});

const FilterQuery = z.object({
  action: z.string().optional().openapi({
    description: "Exactly this action, e.g. `mail.deleted`.",
  }),
  actionPrefix: z.string().optional().openapi({
    description: "Actions that start with this, e.g. `mail.` or `user.`.",
  }),
  actorUserId: z.string().optional(),
  inbox: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  from: z.coerce.number().int().optional().openapi({
    description: "Unix seconds; events at or after this time.",
  }),
  to: z.coerce.number().int().optional().openapi({
    description: "Unix seconds; events at or before this time.",
  }),
  q: z.string().optional().openapi({
    description: "Text contained in the summary or the actor label.",
  }),
});
type Filters = z.infer<typeof FilterQuery>;

type AuditRow = {
  seq: number;
  id: string;
  at: number;
  actor_type: string;
  actor_user_id: string | null;
  actor_label: string;
  channel: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  inbox: string | null;
  summary: string;
  details: string | null;
  ip: string | null;
  user_agent: string | null;
};

function filterSql(filters: Filters): SQL {
  const clauses: SQL[] = [];
  if (filters.action) clauses.push(sql`action = ${filters.action}`);
  if (filters.actionPrefix) {
    clauses.push(
      sql`action LIKE ${`${escapeLike(filters.actionPrefix)}%`} ESCAPE '\\'`,
    );
  }
  if (filters.actorUserId) {
    clauses.push(sql`actor_user_id = ${filters.actorUserId}`);
  }
  if (filters.inbox) {
    clauses.push(sql`inbox = ${filters.inbox.trim().toLowerCase()}`);
  }
  if (filters.targetType)
    clauses.push(sql`target_type = ${filters.targetType}`);
  if (filters.targetId) clauses.push(sql`target_id = ${filters.targetId}`);
  if (filters.from !== undefined) clauses.push(sql`at >= ${filters.from}`);
  if (filters.to !== undefined) clauses.push(sql`at <= ${filters.to}`);
  const text = filters.q?.trim();
  if (text) {
    const pattern = `%${escapeLike(text)}%`;
    clauses.push(
      sql`(summary LIKE ${pattern} ESCAPE '\\' OR actor_label LIKE ${pattern} ESCAPE '\\')`,
    );
  }
  return clauses.length === 0 ? sql`1 = 1` : sql.join(clauses, sql` AND `);
}

/**
 * Where a page ends: the time and the row sequence of its last event. The
 * sequence, not the id, breaks ties, so events of the same second keep the
 * order they happened in.
 */
type Cursor = { at: number; seq: number };

function parseCursor(value: string | undefined): Cursor | null | "invalid" {
  if (value === undefined || value === "") return null;
  const match = /^(\d+):(\d+)$/.exec(value);
  return match ? { at: Number(match[1]), seq: Number(match[2]) } : "invalid";
}

async function readPage(
  db: DrizzleD1Database<any>,
  filters: Filters,
  cursor: Cursor | null,
  limit: number,
): Promise<AuditRow[]> {
  const after = cursor
    ? sql`AND (at < ${cursor.at} OR (at = ${cursor.at} AND rowid < ${cursor.seq}))`
    : sql``;
  return db.all<AuditRow>(sql`
    SELECT rowid AS seq, id, at, actor_type, actor_user_id, actor_label,
      channel, action, target_type, target_id, inbox, summary, details, ip,
      user_agent
    FROM audit_events
    WHERE ${filterSql(filters)} ${after}
    ORDER BY at DESC, rowid DESC
    LIMIT ${limit}
  `);
}

function parseDetails(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin", "Audit log"],
  description:
    "The audit log, newest first: who did what, to what, through which channel. Admin only. Page with `cursor` (the `nextCursor` of the previous page).",
  request: {
    query: FilterQuery.extend({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
    }),
  },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "A page of audit events",
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(AuditEventSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    400: {
      description: "Invalid cursor",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminAuditRouter.openapi(listRoute, async (c) => {
  const {
    cursor: rawCursor,
    limit: rawLimit,
    ...filters
  } = c.req.valid("query");
  const cursor = parseCursor(rawCursor);
  if (cursor === "invalid") return c.json({ error: "Invalid cursor" }, 400);
  const limit = rawLimit ?? DEFAULT_LIMIT;

  const rows = await readPage(c.get("db"), filters, cursor, limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return c.json(
    {
      events: page.map((row) => ({
        id: row.id,
        at: row.at,
        actorType: row.actor_type,
        actorUserId: row.actor_user_id,
        actorLabel: row.actor_label,
        channel: row.channel,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        inbox: row.inbox,
        summary: row.summary,
        details: parseDetails(row.details),
        ip: row.ip,
        userAgent: row.user_agent,
      })),
      nextCursor: rows.length > limit && last ? `${last.at}:${last.seq}` : null,
    },
    200,
  );
});

const actionsRoute = createRoute({
  method: "get",
  path: "/actions",
  tags: ["Admin", "Audit log"],
  description:
    "Every action the audit log can record, sorted, for a filter list.",
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Action names, sorted",
      content: {
        "application/json": {
          schema: z.object({ actions: z.array(z.string()) }),
        },
      },
    },
  },
});

// The catalogue, not a DISTINCT over the table: that would read the whole
// action index every time the page opens.
adminAuditRouter.openapi(actionsRoute, async (c) => {
  return c.json({ actions: Object.values(AUDIT_ACTIONS).sort() }, 200);
});

const exportRoute = createRoute({
  method: "get",
  path: "/export.csv",
  tags: ["Admin", "Audit log"],
  description: `The audit log as CSV, newest first, with the same filters as the list. At most ${AUDIT_EXPORT_MAX_ROWS} rows; narrow the date range for more. Cells are formula-injection-safe.`,
  request: { query: FilterQuery },
  responses: {
    200: {
      description:
        "The events as text/csv, sent as an attachment named audit-log.csv",
    },
  },
});

adminAuditRouter.openapi(exportRoute, async (c) => {
  const db = c.get("db");
  const filters = c.req.valid("query");
  const encoder = new TextEncoder();

  // Streamed a page at a time, so the export never has to fit in memory.
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(
            csvRow([
              "time",
              "actor",
              "actor_type",
              "channel",
              "action",
              "target_type",
              "target_id",
              "inbox",
              "summary",
              "details",
              "ip",
              "user_agent",
            ]),
          ),
        );
        let cursor: Cursor | null = null;
        let written = 0;
        while (written < AUDIT_EXPORT_MAX_ROWS) {
          const rows = await readPage(
            db,
            filters,
            cursor,
            Math.min(EXPORT_PAGE, AUDIT_EXPORT_MAX_ROWS - written),
          );
          if (rows.length === 0) break;
          for (const row of rows) {
            controller.enqueue(
              encoder.encode(
                csvRow([
                  new Date(row.at * 1000).toISOString(),
                  row.actor_label,
                  row.actor_type,
                  row.channel,
                  row.action,
                  row.target_type,
                  row.target_id,
                  row.inbox,
                  row.summary,
                  row.details,
                  row.ip,
                  row.user_agent,
                ]),
              ),
            );
          }
          written += rows.length;
          const last = rows[rows.length - 1];
          cursor = { at: last.at, seq: last.seq };
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="audit-log.csv"',
      "Cache-Control": "no-store",
    },
  });
});
