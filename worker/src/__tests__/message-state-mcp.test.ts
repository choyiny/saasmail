import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  getDb,
} from "./helpers";
import { users } from "../db/auth.schema";
import {
  callTool,
  createUserWithPassword,
  getAccessToken,
  grantInbox,
  type Credentials,
} from "./mcp-helpers";

const MINE = "mine@saasmail.test";
const OTHER = "other@saasmail.test";
const MEMBER: Credentials = {
  name: "State Member",
  email: "state-member@saasmail.test",
  password: "state-member-password",
};

async function memberId(): Promise<string> {
  const [user] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, MEMBER.email))
    .limit(1);
  return user.id;
}

describe("MCP message state tools", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(MEMBER, "member");
    await grantInbox(await memberId(), MINE);
    await createTestPerson({
      id: "mcp-state-person",
      email: "person@example.com",
    });
    await createTestEmail({
      id: "mcp-state-mine",
      personId: "mcp-state-person",
      recipient: MINE,
      messageId: "mcp-state-mine@example.com",
    });
    await createTestEmail({
      id: "mcp-state-other",
      personId: "mcp-state-person",
      recipient: OTHER,
      messageId: "mcp-state-other@example.com",
    });
  });

  it("requires email:manage for set_message_state", async () => {
    const token = await getAccessToken(MEMBER, "openid email:read");
    const out = await callTool(token, "set_message_state", {
      refs: ["received:mcp-state-mine"],
      starred: true,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("email:manage");
  });

  it("returns state access errors as readable failures", async () => {
    const token = await getAccessToken(
      MEMBER,
      "openid email:read email:manage",
    );
    const out = await callTool(token, "set_message_state", {
      refs: ["received:mcp-state-other"],
      starred: true,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not found or not allowed");
    expect(out.text).not.toContain("could not be completed");
  });

  it("lists messages and updates visible state", async () => {
    const token = await getAccessToken(
      MEMBER,
      "openid email:read email:manage",
    );
    let out = await callTool(token, "set_message_state", {
      refs: ["received:mcp-state-mine"],
      starred: true,
    });
    expect(out.isError).toBe(false);

    out = await callTool(token, "list_messages", { starred: true });
    expect(out.isError).toBe(false);
    expect(out.data.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "received:mcp-state-mine" }),
      ]),
    );
  });
  it("snoozes through set_message_state and exposes the snoozed folder", async () => {
    const token = await getAccessToken(
      MEMBER,
      "openid email:read email:manage",
    );
    const until = Math.floor(Date.now() / 1000) + 3600;

    let out = await callTool(token, "set_message_state", {
      refs: ["received:mcp-state-mine"],
      snoozeUntil: until,
    });
    expect(out.isError).toBe(false);

    out = await callTool(token, "list_messages", { folder: "snoozed" });
    expect(out.isError).toBe(false);
    expect(out.data.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "received:mcp-state-mine",
          state: expect.objectContaining({
            conversationKey: "p:mcp-state-person",
            snoozedUntil: until,
          }),
        }),
      ]),
    );
  });
});
