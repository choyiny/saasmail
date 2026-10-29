import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import newsletterSql from "../../../migrations/0035_newsletter_module.sql?raw";
import dataSql from "../../../migrations/0090_remove-subscribe-forms-data.sql?raw";
import schemaSql from "../../../migrations/0091_remove-subscribe-forms.sql?raw";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { campaigns } from "../db/campaigns.schema";
import { contacts } from "../db/contacts.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { signPayload } from "../lib/signed-token";

// The upgrade a live deployment goes through when public subscribe forms are
// removed (docs/newsletters.md, "Adding subscribers"): its data, its API and
// the one-click undo that stays.

function statements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

async function run(sql: string[]) {
  for (const s of sql) await env.DB.prepare(s).run();
}

const FORM_TABLES = [
  "lists",
  "list_members",
  "subscribe_forms",
  "subscribe_attempts",
];

/**
 * The four tables exactly as 0035 created them. No later migration before
 * 0090 touched them, so this is the shape the live databases hold.
 */
function oldTableDdl() {
  return statements(newsletterSql).filter((s) => {
    const m = s.match(
      /^CREATE (?:UNIQUE )?(TABLE|INDEX) `([^`]+)`(?: ON `([^`]+)`)?/,
    );
    if (!m) return false;
    const table = m[1] === "TABLE" ? m[2] : m[3];
    return FORM_TABLES.includes(table);
  });
}

const all = async <T = Record<string, unknown>>(sql: string) =>
  (await env.DB.prepare(sql).all<T>()).results;

beforeAll(applyMigrations);

describe("0090/0091 on the schema the live databases hold", () => {
  it("keeps every column that survives, drops only pending members and the form objects", async () => {
    await run(FORM_TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`));
    const ddl = oldTableDdl();
    // Each table with its indexes: lists 1 + 2, members 1 + 3, forms 1 + 1,
    // attempts 1 + 3.
    expect(ddl).toHaveLength(13);
    await run(ddl);

    await run([
      `INSERT INTO lists (id, name, description, from_address, double_opt_in, confirmation_template_slug, archived_at, created_at, updated_at) VALUES
        ('l1', 'News', 'Weekly news', 'news@x.test', 1, 'confirm-tpl', NULL, 10, 11),
        ('l2', 'Old', 'Archived', 'old@x.test', 0, NULL, 99, 20, 21)`,
      `INSERT INTO subscribe_forms (id, list_id, name, created_at, updated_at) VALUES ('f1', 'l1', 'Footer', 1, 1)`,
      `INSERT INTO subscribe_attempts (id, form_id, email_hash, ip, attempt_type, created_at) VALUES ('a1', 'f1', 'h', '203.0.113.9', 'submission', 1)`,
      `INSERT INTO list_members (id, list_id, contact_id, email, status, source, form_id, submitted_ip, consent_source, consent_at, import_job_id, subscribed_at, confirmed_at, unsubscribed_at, unsubscribe_reason, created_at) VALUES
        ('pending',  'l1', 'c2', 'b@x.test', 'pending',      'form',   'f1', '203.0.113.2', 'form',   100,  NULL,   NULL, NULL, NULL, NULL,               100),
        ('left',     'l1', 'c3', 'c@x.test', 'unsubscribed', 'form',   'f1', NULL,          'form',   100,  NULL,   100,  NULL, 300,  'list_unsubscribe', 101),
        ('imported', 'l1', 'c5', 'e@x.test', 'subscribed',   'import', NULL, NULL,          'import', 50,   'job1', 51,   NULL, NULL, NULL,               52),
        ('mixed',    'l2', 'c1', 'a@x.test', 'subscribed',   'import', NULL, NULL,          'form',   60,   'job2', 61,   NULL, NULL, NULL,               62),
        ('noconsent','l2', 'c6', 'f@x.test', 'subscribed',   'form',   'f1', NULL,          'form',   NULL, NULL,   70,   75,   NULL, NULL,               70),
        ('leftconf', 'l2', 'c7', 'g@x.test', 'unsubscribed', 'form',   'f1', NULL,          'form',   80,   NULL,   80,   90,   95,   'campaign:abc',     80),
        ('rejoined', 'l1', 'c8', 'h@x.test', 'subscribed',   'form',   'f1', NULL,          'form',   300,  NULL,   300,  100,  NULL, NULL,               40)`,
    ]);

    await run(statements(dataSql));
    await run(statements(schemaSql));

    expect(await all(`SELECT * FROM list_members ORDER BY id`)).toEqual([
      {
        id: "imported",
        list_id: "l1",
        contact_id: "c5",
        email: "e@x.test",
        status: "subscribed",
        source: "import",
        consent_source: "import",
        consent_at: 50,
        import_job_id: "job1",
        subscribed_at: 51,
        unsubscribed_at: null,
        unsubscribe_reason: null,
        created_at: 52,
      },
      {
        id: "left",
        list_id: "l1",
        contact_id: "c3",
        email: "c@x.test",
        status: "unsubscribed",
        source: "api",
        consent_source: "api",
        consent_at: 100,
        import_job_id: null,
        subscribed_at: 100,
        unsubscribed_at: 300,
        unsubscribe_reason: "list_unsubscribe",
        created_at: 101,
      },
      {
        id: "leftconf",
        list_id: "l2",
        contact_id: "c7",
        email: "g@x.test",
        status: "unsubscribed",
        source: "api",
        consent_source: "api",
        consent_at: 90,
        import_job_id: null,
        subscribed_at: 80,
        unsubscribed_at: 95,
        unsubscribe_reason: "campaign:abc",
        created_at: 80,
      },
      {
        // Each column is rewritten on its own: an imported row whose consent
        // came from a form keeps `import` as its source.
        id: "mixed",
        list_id: "l2",
        contact_id: "c1",
        email: "a@x.test",
        status: "subscribed",
        source: "import",
        consent_source: "api",
        consent_at: 60,
        import_job_id: "job2",
        subscribed_at: 61,
        unsubscribed_at: null,
        unsubscribe_reason: null,
        created_at: 62,
      },
      {
        id: "noconsent",
        list_id: "l2",
        contact_id: "c6",
        email: "f@x.test",
        status: "subscribed",
        source: "api",
        consent_source: "api",
        consent_at: 75,
        import_job_id: null,
        subscribed_at: 70,
        unsubscribed_at: null,
        unsubscribe_reason: null,
        created_at: 70,
      },
      {
        // Confirmed by double opt-in, left, then rejoined by a single opt-in
        // form: the later consent stays, the older confirmation does not win.
        id: "rejoined",
        list_id: "l1",
        contact_id: "c8",
        email: "h@x.test",
        status: "subscribed",
        source: "api",
        consent_source: "api",
        consent_at: 300,
        import_job_id: null,
        subscribed_at: 300,
        unsubscribed_at: null,
        unsubscribe_reason: null,
        created_at: 40,
      },
    ]);

    expect(await all(`SELECT * FROM lists ORDER BY id`)).toEqual([
      {
        id: "l1",
        name: "News",
        description: "Weekly news",
        from_address: "news@x.test",
        archived_at: null,
        created_at: 10,
        updated_at: 11,
      },
      {
        id: "l2",
        name: "Old",
        description: "Archived",
        from_address: "old@x.test",
        archived_at: 99,
        created_at: 20,
        updated_at: 21,
      },
    ]);

    const objects = await all<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
         AND (tbl_name IN ('lists', 'list_members', 'subscribe_forms', 'subscribe_attempts', '__new_list_members')
              OR name LIKE 'subscribe%')
       ORDER BY name`,
    );
    expect(objects.map((o) => o.name)).toEqual([
      "list_members",
      "list_members_email_idx",
      "list_members_list_contact_unique",
      "list_members_list_status_id_idx",
      "lists",
      "lists_archived_at_idx",
      "lists_from_address_idx",
    ]);

    // The rebuilt table still refuses a second membership for one contact,
    // and a member added without a status is subscribed, not pending.
    await expect(
      env.DB.prepare(
        `INSERT INTO list_members (id, list_id, contact_id, email, source, consent_source, created_at)
         VALUES ('dup', 'l1', 'c3', 'c@x.test', 'api', 'api', 1)`,
      ).run(),
    ).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare(
      `INSERT INTO list_members (id, list_id, contact_id, email, source, consent_source, created_at)
       VALUES ('fresh', 'l1', 'c9', 'z@x.test', 'api', 'api', 1)`,
    ).run();
    expect(
      await all(`SELECT status FROM list_members WHERE id = 'fresh'`),
    ).toEqual([{ status: "subscribed" }]);
  });
});

const FROM = "news@example.com";

async function adminKey() {
  const { apiKey } = await createTestUser({
    id: "u-admin",
    role: "admin",
    email: "admin@example.com",
  });
  return apiKey;
}

describe("list API without subscribe forms", () => {
  it("refuses pending, serves no form endpoints and returns no removed fields", async () => {
    await cleanDb();
    const apiKey = await adminKey();
    const created = await authFetch("/api/lists", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "Weekly",
        fromAddress: FROM,
        doubleOptIn: true,
        confirmationTemplateSlug: "confirm",
      }),
    });
    expect(created.status).toBe(201);
    const list = await created.json<Record<string, unknown>>();
    const listKeys = [
      "archivedAt",
      "createdAt",
      "description",
      "fromAddress",
      "id",
      "name",
      "updatedAt",
    ];
    expect(Object.keys(list).sort()).toEqual(listKeys);

    const added = await authFetch(`/api/lists/${list.id}/members`, {
      apiKey,
      method: "POST",
      body: JSON.stringify({ email: "a@example.com", source: "form" }),
    });
    expect(added.status).toBe(201);
    const member = await added.json<Record<string, unknown>>();
    const memberKeys = [
      "consentAt",
      "consentSource",
      "contactId",
      "createdAt",
      "email",
      "id",
      "listId",
      "name",
      "source",
      "status",
      "subscribedAt",
      "unsubscribedAt",
    ];
    expect(Object.keys(member).sort()).toEqual(memberKeys);
    expect(member).toMatchObject({
      source: "api",
      consentSource: "api",
      status: "subscribed",
    });

    const index = await (
      await authFetch("/api/lists", { apiKey })
    ).json<{ items: Record<string, unknown>[] }>();
    expect(Object.keys(index.items[0]).sort()).toEqual(listKeys);

    const detail = await (
      await authFetch(`/api/lists/${list.id}`, { apiKey })
    ).json<Record<string, unknown>>();
    expect(Object.keys(detail).sort()).toEqual(
      [...listKeys, "memberCounts"].sort(),
    );
    expect(detail.memberCounts).toEqual({ subscribed: 1, unsubscribed: 0 });

    const members = await (
      await authFetch(`/api/lists/${list.id}/members`, { apiKey })
    ).json<{ items: Record<string, unknown>[] }>();
    expect(Object.keys(members.items[0]).sort()).toEqual(memberKeys);

    for (const path of [
      `/api/lists/${list.id}/members?status=pending`,
      `/api/lists/${list.id}/members/export?status=pending`,
    ]) {
      const res = await authFetch(path, { apiKey });
      expect(res.status, path).toBe(400);
    }

    // The admin form endpoints are gone: no JSON API answer, no new rows.
    // The path falls through to the static assets, which answer a GET with
    // the app's HTML shell when a front end is built and 404 when not.
    const formsGet = await authFetch("/api/subscribe-forms", { apiKey });
    expect(formsGet.headers.get("Content-Type") ?? "").not.toContain("json");
    const formsPost = await authFetch("/api/subscribe-forms", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ listId: list.id, name: "Footer" }),
    });
    expect(formsPost.ok).toBe(false);
    expect(
      await all(`SELECT name FROM sqlite_master WHERE name LIKE 'subscribe_%'`),
    ).toEqual([]);
  });
});

// Matches the binding in vitest.config.test.ts.
const SECRET = "test-secret-do-not-use-in-prod";

describe("one-click undo after the forms are gone", () => {
  it("restores only the membership its own token removed", async () => {
    await cleanDb();
    const t = Math.floor(Date.now() / 1000);
    const db = getDb();
    for (const id of ["list-a", "list-b"]) {
      await db.insert(lists).values({
        id,
        name: id,
        description: null,
        fromAddress: FROM,
        archivedAt: null,
        createdAt: t,
        updatedAt: t,
      });
    }
    await db.insert(campaigns).values({
      id: "camp-a",
      name: "Issue 1",
      subject: "Issue 1",
      templateSlug: "weekly",
      fromAddress: FROM,
      listId: "list-a",
      status: "sent",
      createdAt: t,
      updatedAt: t,
    });
    await db.insert(contacts).values({
      id: "contact-1",
      email: "reader@example.com",
      name: null,
      personId: null,
      createdAt: t,
      updatedAt: t,
    });
    const base = {
      contactId: "contact-1",
      email: "reader@example.com",
      source: "api" as const,
      consentSource: "api" as const,
      consentAt: t - 100,
      importJobId: null,
      subscribedAt: t - 100,
      createdAt: t - 100,
    };
    await db.insert(listMembers).values([
      {
        ...base,
        id: "m-a",
        listId: "list-a",
        status: "subscribed",
        unsubscribedAt: null,
        unsubscribeReason: null,
      },
      // The same person also left list B, on their own, a minute ago.
      {
        ...base,
        id: "m-b",
        listId: "list-b",
        status: "unsubscribed",
        unsubscribedAt: t - 60,
        unsubscribeReason: "user",
      },
    ]);

    const token = await signPayload(
      {
        v: 2,
        e: "reader@example.com",
        l: "list-a",
        c: "camp-a",
        k: "contact-1",
      },
      SECRET,
      "unsubscribe",
    );
    const post = (path: string) =>
      exports.default.fetch(
        `http://localhost${path}?token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );

    expect((await post("/api/unsubscribe")).status).toBe(200);
    expect((await post("/api/unsubscribe/undo")).status).toBe(200);

    const rows = await db.select().from(listMembers);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["m-a"].status).toBe("subscribed");
    expect(byId["m-b"]).toMatchObject({
      status: "unsubscribed",
      unsubscribedAt: t - 60,
      unsubscribeReason: "user",
    });

    // A forged token for list B, signed with the wrong secret, restores nothing.
    const forged = await signPayload(
      {
        v: 2,
        e: "reader@example.com",
        l: "list-b",
        c: "camp-a",
        k: "contact-1",
      },
      "not-the-secret",
      "unsubscribe",
    );
    const r = await exports.default.fetch(
      `http://localhost/api/unsubscribe/undo?token=${encodeURIComponent(forged)}`,
      { method: "POST" },
    );
    expect(r.ok).toBe(false);
    const [b] = await db
      .select()
      .from(listMembers)
      .where(eq(listMembers.id, "m-b"));
    expect(b.status).toBe("unsubscribed");
  });
});
