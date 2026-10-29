import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import dataSql from "../../../migrations/0090_remove-subscribe-forms-data.sql?raw";
import schemaSql from "../../../migrations/0091_remove-subscribe-forms.sql?raw";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { lists } from "../db/lists.schema";
import { listMembers } from "../db/list-members.schema";

async function runMigration(sql: string) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    const executable = statement
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (executable) await env.DB.prepare(executable).run();
  }
}

// The tables as they were before 0090, when public subscribe forms existed.
const OLD_SCHEMA = [
  `DROP TABLE IF EXISTS list_members`,
  `DROP TABLE IF EXISTS lists`,
  `CREATE TABLE lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, from_address TEXT NOT NULL, double_opt_in INTEGER NOT NULL DEFAULT 0, confirmation_template_slug TEXT, archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE list_members (id TEXT PRIMARY KEY, list_id TEXT NOT NULL, contact_id TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', source TEXT NOT NULL, form_id TEXT, submitted_ip TEXT, consent_source TEXT NOT NULL, consent_at INTEGER, import_job_id TEXT, subscribed_at INTEGER, confirmed_at INTEGER, unsubscribed_at INTEGER, unsubscribe_reason TEXT, created_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX list_members_list_contact_unique ON list_members(list_id, contact_id)`,
  `CREATE INDEX list_members_list_status_id_idx ON list_members(list_id, status, id)`,
  `CREATE INDEX list_members_email_idx ON list_members(email)`,
  `CREATE TABLE subscribe_forms (id TEXT PRIMARY KEY, list_id TEXT NOT NULL, name TEXT NOT NULL, show_name_field INTEGER NOT NULL DEFAULT 1, name_required INTEGER NOT NULL DEFAULT 0, success_message TEXT NOT NULL DEFAULT 'Thanks for subscribing!', redirect_url TEXT, allowed_origins TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE subscribe_attempts (id TEXT PRIMARY KEY, form_id TEXT NOT NULL, email_hash TEXT NOT NULL, ip TEXT NOT NULL, attempt_type TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];

describe("0090/0091 remove subscribe forms", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("keeps the confirmation as consent, deletes pending members and rewrites the form source", async () => {
    for (const statement of OLD_SCHEMA) await env.DB.prepare(statement).run();
    await env.DB.prepare(
      `INSERT INTO lists (id, name, from_address, double_opt_in, created_at, updated_at)
       VALUES ('l1', 'News', 'news@saasmail.test', 1, 1, 1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO list_members (id, list_id, contact_id, email, status, source, form_id, submitted_ip, consent_source, consent_at, subscribed_at, confirmed_at, unsubscribed_at, created_at) VALUES
       ('confirmed', 'l1', 'c1', 'a@example.com', 'subscribed', 'form', 'f1', '203.0.113.1', 'form', 100, 200, 200, NULL, 100),
       ('left', 'l1', 'c2', 'b@example.com', 'unsubscribed', 'form', 'f1', NULL, 'form', 100, 100, NULL, 300, 100),
       ('waiting', 'l1', 'c3', 'c@example.com', 'pending', 'form', 'f1', '203.0.113.2', 'form', 100, NULL, NULL, NULL, 100),
       ('imported', 'l1', 'c4', 'd@example.com', 'subscribed', 'import', NULL, NULL, 'import', 50, 50, NULL, NULL, 50)`,
    ).run();

    await runMigration(dataSql);
    await runMigration(schemaSql);

    const { results } = await env.DB.prepare(
      `SELECT * FROM list_members ORDER BY id`,
    ).all<Record<string, unknown>>();
    expect(results).toEqual([
      expect.objectContaining({
        id: "confirmed",
        status: "subscribed",
        source: "api",
        consent_source: "api",
        consent_at: 200,
      }),
      expect.objectContaining({
        id: "imported",
        source: "import",
        consent_source: "import",
        consent_at: 50,
      }),
      expect.objectContaining({
        id: "left",
        status: "unsubscribed",
        source: "api",
        consent_source: "api",
        consent_at: 100,
      }),
    ]);
    expect(Object.keys(results[0])).not.toContain("confirmed_at");
    expect(Object.keys(results[0])).not.toContain("submitted_ip");

    const { results: tables } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('subscribe_forms', 'subscribe_attempts')`,
    ).all();
    expect(tables).toEqual([]);
    const { results: listColumns } = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('lists')`,
    ).all<{ name: string }>();
    expect(listColumns.map((c) => c.name)).not.toContain("double_opt_in");
  });
});

describe("public subscribe endpoints", () => {
  // The bug: a form or a confirm link re-subscribed people who had opted out.
  // The routes are gone, so these requests fall through to the static assets
  // and touch no member. The POST is refused: 405 with a built front end,
  // 404 without one (as in CI), so the test checks only that it failed.
  it("no longer re-subscribes a member who left", async () => {
    await cleanDb();
    const db = getDb();
    await db.insert(lists).values({
      id: "l2",
      name: "News",
      description: null,
      fromAddress: "news@saasmail.test",
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await db.insert(listMembers).values({
      id: "m-left",
      listId: "l2",
      contactId: "c-left",
      email: "left@example.com",
      status: "unsubscribed",
      source: "api",
      consentSource: "api",
      consentAt: 1,
      importJobId: null,
      subscribedAt: 1,
      unsubscribedAt: 2,
      unsubscribeReason: null,
      createdAt: 1,
    });

    const post = await exports.default.fetch("http://localhost/subscribe/l2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "left@example.com" }),
    });
    expect(post.ok).toBe(false);
    await exports.default.fetch("http://localhost/subscribe/confirm/any-token");

    const [member] = await db
      .select()
      .from(listMembers)
      .where(eq(listMembers.id, "m-left"));
    expect(member.status).toBe("unsubscribed");
    expect(member.unsubscribedAt).toBe(2);
  });
});
