// docs/mcp.md: wait_for_test_mail mirrors GET /api/test-mail/wait.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestPerson, getDb } from "./helpers";
import { users } from "../db/auth.schema";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  callTool,
  createUserWithPassword,
  getAccessToken,
  grantInbox,
  type Credentials,
} from "./mcp-helpers";

const TEST_INBOX = "e2e@saasmail.test";
const NORMAL_INBOX = "support@saasmail.test";
const MEMBER: Credentials = {
  name: "Test Mail Member",
  email: "test-mail-member@saasmail.test",
  password: "test-mail-member-password",
};

describe("MCP wait_for_test_mail", () => {
  let token = "";

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(MEMBER, "member");
    const [user] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, MEMBER.email))
      .limit(1);
    await grantInbox(user.id, TEST_INBOX);
    await grantInbox(user.id, NORMAL_INBOX);
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(senderIdentities)
      .values([
        { email: TEST_INBOX, purpose: "test", createdAt: now, updatedAt: now },
        { email: NORMAL_INBOX, createdAt: now, updatedAt: now },
      ]);
    await createTestPerson({ id: "sender-1", email: "no-reply@example.com" });
    await getDb().insert(emails).values({
      id: "mcp-test-mail",
      personId: "sender-1",
      recipient: TEST_INBOX,
      recipientDetail: "run7",
      subject: "Your code",
      bodyText: "Use 551234 at https://example.com/verify?x=1",
      messageId: "<mcp-test-mail@example.com>",
      receivedAt: now,
      createdAt: now,
    });
    token = await getAccessToken(MEMBER, "openid email:read");
  });

  it("returns the matching message with its links and codes", async () => {
    const out = await callTool(token, "wait_for_test_mail", {
      inbox: TEST_INBOX,
      detail: "run7",
      since: 0,
      timeout: 1,
    });
    expect(out.isError).toBe(false);
    expect(out.data).toMatchObject({
      found: true,
      message: {
        id: "mcp-test-mail",
        detail: "run7",
        links: ["https://example.com/verify?x=1"],
        codes: ["551234"],
      },
    });
  });

  it("reports found: false when nothing matches in time", async () => {
    const out = await callTool(token, "wait_for_test_mail", {
      inbox: TEST_INBOX,
      detail: "other",
      since: 0,
      timeout: 1,
    });
    expect(out.data).toEqual({ found: false });
  });

  it("refuses a normal inbox with a tool error", async () => {
    const out = await callTool(token, "wait_for_test_mail", {
      inbox: NORMAL_INBOX,
      since: 0,
      timeout: 1,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Not a test inbox");
  });
});
