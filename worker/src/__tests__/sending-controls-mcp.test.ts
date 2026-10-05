// docs/sending.md: the MCP kill switch and the MCP daily cap.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { users } from "../db/auth.schema";
import { utcDay } from "../lib/sending-controls";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestTemplate,
  getDb,
} from "./helpers";
import {
  ALL_SCOPES,
  type Credentials,
  callTool,
  createUserWithPassword,
  getAccessToken,
  mcpRpc,
  readRpc,
} from "./mcp-helpers";

const INBOX = "support@saasmail.test";
const DISABLED =
  "MCP_SEND_DISABLED: Sending through MCP is disabled on this server by its administrator.";

const ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

const sendArgs = {
  to: "alice@example.com",
  fromAddress: INBOX,
  subject: "Hello",
  bodyHtml: "<p>hi</p>",
};

describe("sending controls over MCP", () => {
  let token: string;
  let userId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
    const [row] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ADMIN.email));
    userId = row.id;
    token = await getAccessToken(ADMIN, ALL_SCOPES);
    (env as any).DEMO_MODE = "1";
  });

  afterEach(() => {
    (env as any).DEMO_MODE = "0";
    delete (env as any).MCP_SEND_ENABLED;
  });

  describe("MCP_SEND_ENABLED=false", () => {
    beforeEach(() => {
      (env as any).MCP_SEND_ENABLED = "false";
    });

    it("refuses each tool that causes mail, before doing anything", async () => {
      await createTestPerson({ id: "p1", email: "alice@example.com" });
      await createTestEmail({ id: "e1", personId: "p1", recipient: INBOX });
      await createTestTemplate({ slug: "welcome", subject: "Hi" });
      const calls: [string, Record<string, unknown>][] = [
        ["send_email", sendArgs],
        [
          "reply_email",
          { emailId: "e1", fromAddress: INBOX, bodyHtml: "<p>ok</p>" },
        ],
        [
          "send_template",
          { slug: "welcome", to: "alice@example.com", fromAddress: INBOX },
        ],
        [
          "enroll_sequence",
          {
            sequenceId: "missing",
            personEmail: "alice@example.com",
            fromAddress: INBOX,
          },
        ],
      ];
      for (const [name, args] of calls) {
        const out = await callTool(token, name, args);
        expect(out, name).toMatchObject({ isError: true, text: DISABLED });
      }
      expect(await getDb().all(sql`SELECT id FROM sent_emails`)).toEqual([]);
    });

    it("keeps the tools listed and says so in whoami", async () => {
      const body = await readRpc(await mcpRpc(token, "tools/list"));
      const names = (body.result.tools as { name: string }[]).map(
        (tool) => tool.name,
      );
      expect(names).toEqual(
        expect.arrayContaining([
          "send_email",
          "reply_email",
          "send_template",
          "enroll_sequence",
        ]),
      );
      const whoami = await callTool(token, "whoami");
      expect(whoami.data.sendEnabled).toBe(false);
    });

    it("still answers a token without the send scope with the scope error", async () => {
      const readOnly = await getAccessToken(ADMIN, "openid email:read");
      const out = await callTool(readOnly, "send_email", sendArgs);
      expect(out.isError).toBe(true);
      expect(out.text).toContain('requires the "email:send" scope');
    });
  });

  it("reports sendEnabled: true by default", async () => {
    const whoami = await callTool(token, "whoami");
    expect(whoami.data.sendEnabled).toBe(true);
  });

  it("refuses the 201st send of a UTC day by default", async () => {
    const today = utcDay(Math.floor(Date.now() / 1000));
    await getDb().run(
      sql`INSERT INTO send_counters (user_id, channel, day, count) VALUES (${userId}, 'mcp', ${today}, 199)`,
    );

    const last = await callTool(token, "send_email", sendArgs);
    expect(last.isError).toBe(false);

    const over = await callTool(token, "send_email", {
      ...sendArgs,
      subject: "One more",
    });
    expect(over).toMatchObject({
      isError: true,
      text: "DAILY_SEND_LIMIT_REACHED: Daily send limit reached: 200 messages a day through mcp. It resets at midnight UTC.",
    });
    const [row] = await getDb().all<{ count: number }>(
      sql`SELECT count FROM send_counters WHERE user_id = ${userId} AND channel = 'mcp'`,
    );
    expect(Number(row.count)).toBe(200);
    expect(await getDb().all(sql`SELECT id FROM sent_emails`)).toHaveLength(1);
  });

  it("does not count a replayed tool call, nor a refused one", async () => {
    const today = utcDay(Math.floor(Date.now() / 1000));
    await getDb().run(
      sql`INSERT INTO send_counters (user_id, channel, day, count) VALUES (${userId}, 'mcp', ${today}, 199)`,
    );
    const key = "7d1c3e5a-9b2f-4c6d-8e0a-1b2c3d4e5f6a";

    // Refused (no such template): the slot comes back.
    const refused = await callTool(token, "send_template", {
      slug: "missing",
      to: "alice@example.com",
      fromAddress: INBOX,
    });
    expect(refused.isError).toBe(true);

    const first = await callTool(token, "send_email", {
      ...sendArgs,
      idempotencyKey: key,
    });
    expect(first.isError).toBe(false);
    const replay = await callTool(token, "send_email", {
      ...sendArgs,
      idempotencyKey: key,
    });
    expect(replay.isError).toBe(false);
    expect(replay.data.replayed).toBe(true);

    const [row] = await getDb().all<{ count: number }>(
      sql`SELECT count FROM send_counters WHERE user_id = ${userId} AND channel = 'mcp'`,
    );
    expect(Number(row.count)).toBe(200);
  });
});
