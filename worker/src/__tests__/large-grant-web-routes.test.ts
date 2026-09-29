// D1 binds at most 100 parameters per statement. A member granted 150 inboxes
// reads the web routes that scope by the grant (people, stats, conversations,
// templates) through the real worker, with each statement's bound-parameter
// count recorded; the answers must match a member granted only the inboxes
// that hold mail, and never include the inbox neither is granted.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emails } from "../db/emails.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import worker from "../index";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";

const D1_MAX_PARAMS = 100;
const GRANTED = Array.from(
  { length: 150 },
  (_, index) => `box${String(index + 1).padStart(3, "0")}@big.test`,
);
const FIRST = GRANTED[0];
const LAST = GRANTED[149];
const CONTROL = "control@big.test";

type Statement = { sql: string; params: number };

/** env.DB with every statement and its bound-parameter count recorded. */
function recordingD1(): { db: D1Database; statements: Statement[] } {
  const statements: Statement[] = [];
  const wrap = (statement: any, entry: Statement): any =>
    new Proxy(statement, {
      get(target, prop) {
        const value = target[prop];
        if (prop === "bind") {
          return (...args: unknown[]) => {
            entry.params = args.length;
            return wrap(value.apply(target, args), entry);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const entry = { sql: query, params: 0 };
          statements.push(entry);
          return wrap(target.prepare(query), entry);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, statements };
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

/** A request through the real worker on a recorded D1: `status`, every statement ≤ 100 parameters. */
async function get(
  path: string,
  apiKey: string,
  init: RequestInit = {},
  status = 200,
) {
  const recorded = recordingD1();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  const response = await worker.fetch!(
    new Request(`http://localhost${path}`, { ...init, headers }) as any,
    { ...env, DB: recorded.db } as unknown as CloudflareBindings,
    ctx,
  );
  expect(response.status, path).toBe(status);
  expect(recorded.statements.length).toBeGreaterThan(0);
  expect(
    recorded.statements
      .filter((s) => s.params > D1_MAX_PARAMS)
      .map((s) => `${s.params}: ${s.sql.slice(0, 200)}`),
    path,
  ).toEqual([]);
  return (await response.json()) as any;
}

async function member(id: string, inboxes: string[]) {
  const { userId, apiKey } = await createTestUser({
    id,
    role: "member",
    email: `${id}@example.com`,
  });
  const now = Math.floor(Date.now() / 1000);
  // A multi-row insert of 32+ permission rows would itself pass 100.
  for (let start = 0; start < inboxes.length; start += 10) {
    await getDb()
      .insert(inboxPermissions)
      .values(
        inboxes.slice(start, start + 10).map((email) => ({
          userId,
          email,
          createdAt: now,
          createdBy: null,
        })),
      );
  }
  return apiKey;
}

async function seed() {
  await createTestPerson({ id: "p-in", email: "in@example.com" });
  await createTestPerson({ id: "p-sent", email: "sent@example.com" });
  await createTestPerson({ id: "p-out", email: "out@example.com" });
  await createTestEmail({
    id: "e-in",
    personId: "p-in",
    recipient: FIRST,
    messageId: "e-in@example.com",
    conversationId: "conv-in",
  });
  await createTestSentEmail({
    id: "s-last",
    personId: "p-sent",
    fromAddress: LAST,
    toAddress: "sent@example.com",
    conversationId: "conv-sent",
  });
  await createTestEmail({
    id: "e-out",
    personId: "p-out",
    recipient: CONTROL,
    messageId: "e-out@example.com",
    conversationId: "conv-out",
  });
  const now = Math.floor(Date.now() / 1000);
  for (const [id, fromAddress] of [
    ["t-first", FIRST],
    ["t-control", CONTROL],
    ["t-any", null],
  ] as const) {
    await getDb().insert(emailTemplates).values({
      id,
      slug: id,
      name: id,
      subject: "Hello",
      bodyHtml: "<p>Hi</p>",
      fromAddress,
      createdAt: now,
      updatedAt: now,
    });
  }
  return {
    many: await member("grant-many", GRANTED),
    // Only the inboxes that hold mail: under the old ceiling.
    few: await member("grant-few", [FIRST, LAST]),
  };
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe("web routes for a member granted 150 inboxes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("GET /api/people and /api/people/grouped: the same people as a two-inbox grant, never the control inbox's", async () => {
    const { many, few } = await seed();
    const listed = await get("/api/people", many);
    expect(ids(listed.data)).toEqual(ids((await get("/api/people", few)).data));
    expect(ids(listed.data)).toContain("p-in");
    expect(ids(listed.data)).not.toContain("p-out");

    const grouped = await get("/api/people/grouped", many);
    expect(JSON.stringify(grouped)).toBe(
      JSON.stringify(await get("/api/people/grouped", few)),
    );
    expect(JSON.stringify(grouped)).toContain("p-in");
    expect(JSON.stringify(grouped)).not.toContain("p-out");
  });

  it("GET /api/stats: the same totals as a two-inbox grant", async () => {
    const { many, few } = await seed();
    const stats = await get("/api/stats", many);
    expect(stats).toEqual(await get("/api/stats", few));
    expect(stats.totalEmails).toBe(1);
    expect(stats.totalPeople).toBe(1);
  });

  it("GET /api/conversations/{id}/emails and POST mark-read stay in the grant", async () => {
    const { many, few } = await seed();
    const inScope = await get("/api/conversations/conv-in/emails", many);
    expect(inScope).toEqual(
      await get("/api/conversations/conv-in/emails", few),
    );
    expect(JSON.stringify(inScope)).toContain("e-in");
    // Outside the grant: not found, as for any member.
    await get("/api/conversations/conv-out/emails", many, {}, 404);

    const marked = await get("/api/conversations/mark-read", many, {
      method: "POST",
      body: JSON.stringify({ conversationIds: ["conv-in", "conv-out"] }),
    });
    expect(marked).toMatchObject({ success: true, affected: 1 });
    const [control] = await getDb()
      .select({ isRead: emails.isRead })
      .from(emails)
      .where(eq(emails.id, "e-out"));
    expect(control.isRead).toBe(0);
  });

  it("GET /api/email-templates: the grant's and the unscoped templates, as for a two-inbox grant", async () => {
    const { many, few } = await seed();
    const templates = await get("/api/email-templates", many);
    expect(ids(templates)).toEqual(["t-any", "t-first"]);
    expect(ids(await get("/api/email-templates", few))).toEqual(ids(templates));
  });
});
