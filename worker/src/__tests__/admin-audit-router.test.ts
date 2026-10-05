// docs/audit-log.md: the admin API over the audit log.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { auditEvents } from "../db/audit-events.schema";
import { AUDIT_EXPORT_MAX_ROWS } from "../routers/admin-audit-router";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";

type Event = {
  id: string;
  at: number;
  action: string;
  actorLabel: string;
  inbox: string | null;
  summary: string;
  details: Record<string, unknown> | null;
};

const BASE = "/api/admin/audit";

async function seed(rows: Partial<typeof auditEvents.$inferInsert>[]) {
  for (const [index, row] of rows.entries()) {
    await getDb()
      .insert(auditEvents)
      .values({
        id: `ev-${index}`,
        at: 1_000 + index,
        actorType: "user",
        actorUserId: "u-jane",
        actorLabel: "jane@acme.com",
        channel: "web",
        action: "mail.archived",
        summary: `Event ${index}`,
        ...row,
      });
  }
}

async function list(apiKey: string, query = "") {
  const res = await authFetch(`${BASE}${query}`, { apiKey });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { events: Event[]; nextCursor: string | null };
}

describe("GET /api/admin/audit", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  it("is for admins only", async () => {
    const member = await createTestUser({
      id: "audit-member",
      email: "member@example.com",
      role: "member",
    });
    for (const path of [BASE, `${BASE}/actions`, `${BASE}/export.csv`]) {
      const res = await authFetch(path, { apiKey: member.apiKey });
      expect(res.status, path).toBe(403);
    }
  });

  it("returns events newest first with parsed details", async () => {
    await seed([
      { summary: "first", details: '{"count":2}' },
      { summary: "second" },
    ]);
    const { events, nextCursor } = await list(apiKey);
    expect(events.map((event) => event.summary)).toEqual(["second", "first"]);
    expect(events[1].details).toEqual({ count: 2 });
    expect(events[0].details).toBeNull();
    expect(nextCursor).toBeNull();
  });

  it("keeps events of the same second in the order they happened", async () => {
    await seed([
      { at: 5_000, summary: "created" },
      { at: 5_000, summary: "renamed" },
      { at: 5_000, summary: "deleted" },
    ]);
    const { events } = await list(apiKey);
    expect(events.map((event) => event.summary)).toEqual([
      "deleted",
      "renamed",
      "created",
    ]);
  });

  it("pages with the cursor, without gaps or repeats", async () => {
    await seed(
      Array.from({ length: 7 }, (_, i) => ({
        // Four share a second, so that second straddles a page boundary and
        // only the row sequence can tell where the next page starts.
        at: i >= 1 && i <= 4 ? 2_000 : 1_000 + i,
        summary: `n${i}`,
      })),
    );
    const seen: string[] = [];
    let cursor: string | null = "";
    let pages = 0;
    while (cursor !== null) {
      const page: { events: Event[]; nextCursor: string | null } = await list(
        apiKey,
        `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...page.events.map((event) => event.summary));
      cursor = page.nextCursor;
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(["n4", "n3", "n2", "n1", "n6", "n5", "n0"]);
  });

  it("rejects a cursor it did not issue", async () => {
    const res = await authFetch(`${BASE}?cursor=nonsense`, { apiKey });
    expect(res.status).toBe(400);
  });

  it("filters by action, prefix, actor, inbox, target, time and text", async () => {
    await seed([
      { action: "mail.archived", inbox: "support@acme.com", summary: "a" },
      { action: "mail.deleted", inbox: "billing@acme.com", summary: "b" },
      {
        action: "rule.created",
        actorUserId: "u-bob",
        actorLabel: "bob@acme.com",
        targetType: "rule",
        targetId: "r1",
        summary: "Created the rule 'Invoices 100%'",
      },
      { action: "user.removed", at: 9_000, summary: "d" },
    ]);
    const summaries = async (query: string) =>
      (await list(apiKey, query)).events.map((event) => event.summary);

    expect(await summaries("?action=mail.deleted")).toEqual(["b"]);
    expect(await summaries("?actionPrefix=mail.")).toEqual(["b", "a"]);
    expect(await summaries("?actorUserId=u-bob")).toHaveLength(1);
    expect(await summaries("?inbox=Support%40ACME.com")).toEqual(["a"]);
    expect(await summaries("?targetType=rule&targetId=r1")).toHaveLength(1);
    expect(await summaries("?from=9000")).toEqual(["d"]);
    expect(await summaries("?to=1001")).toEqual(["b", "a"]);
    expect(await summaries("?q=bob%40acme")).toHaveLength(1);
    // `%` and `_` in the text are literal, not wildcards.
    expect(await summaries("?q=100%25")).toHaveLength(1);
    expect(await summaries("?q=1_0")).toEqual([]);
  });

  it("lists every action the log can record, sorted", async () => {
    const res = await authFetch(`${BASE}/actions`, { apiKey });
    const { actions } = (await res.json()) as { actions: string[] };
    expect(actions).toEqual([...actions].sort());
    expect(new Set(actions).size).toBe(actions.length);
    for (const action of ["mail.sent", "user.impersonated", "rule.toggled"]) {
      expect(actions).toContain(action);
    }
  });

  it("exports the filtered events as CSV, safe for spreadsheets", async () => {
    await seed([
      { action: "mail.archived", summary: "kept out" },
      {
        action: "mail.deleted",
        summary: '=HYPERLINK("http://evil","x"), with a comma',
        details: '{"count":1}',
      },
    ]);
    const res = await authFetch(`${BASE}/export.csv?action=mail.deleted`, {
      apiKey,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");

    const lines = (await res.text()).trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "time,actor,actor_type,channel,action,target_type,target_id,inbox,summary,details,ip,user_agent",
    );
    expect(lines[1]).toContain("1970-01-01T00:16:41.000Z,jane@acme.com,user");
    // The formula is neutralised and the cell quoted.
    expect(lines[1]).not.toContain(",=HYPERLINK");
    expect(lines[1]).toContain('""x""');
  });

  it("bounds the export", async () => {
    await getDb().run(sql`
      INSERT INTO audit_events
        (id, at, actor_type, actor_label, channel, action, summary)
      WITH RECURSIVE n(i) AS (
        SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${AUDIT_EXPORT_MAX_ROWS + 25}
      )
      SELECT 'bulk-' || i, 1000 + i, 'system', 'system', 'cron', 'mail.sent',
        'Sent ' || i
      FROM n
    `);
    const res = await authFetch(`${BASE}/export.csv`, { apiKey });
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines).toHaveLength(AUDIT_EXPORT_MAX_ROWS + 1);
    // Newest first: the oldest 25 are the ones left out.
    expect(lines[1]).toContain(`Sent ${AUDIT_EXPORT_MAX_ROWS + 25}`);
    expect(lines[lines.length - 1]).toContain("Sent 26");
  });
});
