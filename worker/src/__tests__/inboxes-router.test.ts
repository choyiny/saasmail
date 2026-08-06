import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { classifyRoute } from "../lib/oauth-scope-policy";

const MINE = "mine@x.com";
const OTHER = "other@x.com";

/**
 * Put an address into the inbox universe by giving it a received message.
 *
 * `createTestEmail` defaults both `id` and `messageId` to fixed values, and
 * `emails.message_id` is UNIQUE — so seeding two inboxes in one test needs
 * distinct ones or the second insert fails on the constraint rather than on
 * anything the test is about.
 */
let seq = 0;
async function seedInbox(recipient: string) {
  seq += 1;
  await createTestEmail({
    id: `email-${seq}`,
    messageId: `msg-${seq}@example.com`,
    personId: "p1",
    recipient,
  });
}

async function assign(userId: string, email: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
}

async function configure(
  email: string,
  fields: Partial<{
    displayName: string;
    displayMode: "thread" | "chat";
    signatureHtml: string;
  }> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({
      email,
      displayName: fields.displayName ?? null,
      displayMode: fields.displayMode ?? "thread",
      signatureHtml: fields.signatureHtml ?? null,
      createdAt: now,
      updatedAt: now,
    });
}

/**
 * A member, not an admin.
 *
 * `createTestUser` defaults to `role: "admin"` and `resolveAllowedInboxes`
 * short-circuits for admins, so a suite that forgets this never exercises the
 * scoping at all — it asserts that an unrestricted caller sees everything and
 * calls that a pass.
 */
async function createMember(id = "u-member") {
  const { apiKey, userId } = await createTestUser({
    id,
    role: "member",
    email: `${id}@x.com`,
  });
  return { apiKey, userId };
}

type InboxRow = {
  email: string;
  displayName: string | null;
  displayMode: "thread" | "chat";
  signatureHtml: string | null;
};

async function listInboxes(apiKey: string) {
  const res = await authFetch("/api/inboxes", { apiKey });
  return { res, body: (await res.json()) as InboxRow[] };
}

describe("GET /api/inboxes", () => {
  beforeAll(applyMigrations);
  beforeEach(cleanDb);

  it("returns every inbox in the universe for an admin", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson({ id: "p1", email: "sender@out.com" });
    // One inbox known only from received mail, one only from configuration.
    await seedInbox(MINE);
    await configure(OTHER, { displayName: "Other Desk" });

    const { res, body } = await listInboxes(apiKey);

    expect(res.status).toBe(200);
    expect(body.map((r) => r.email).sort()).toEqual([MINE, OTHER]);
  });

  it("returns only the inboxes assigned to a member", async () => {
    const { apiKey, userId } = await createMember();
    await createTestPerson({ id: "p1", email: "sender@out.com" });
    await seedInbox(MINE);
    await seedInbox(OTHER);
    await assign(userId, MINE);

    const { res, body } = await listInboxes(apiKey);

    expect(res.status).toBe(200);
    expect(body.map((r) => r.email)).toEqual([MINE]);
  });

  /**
   * The empty grant is the case that breaks naively.
   *
   * An inlined `IN ()` is a SQLite syntax error, so a member with no
   * assignments would get a 500 rather than an empty list — and the obvious
   * "fix" of skipping the filter when the list is empty scopes nothing and
   * hands them every inbox on the deployment.
   */
  it("returns an empty list, not an error, for a member with no assignments", async () => {
    const { apiKey } = await createMember();
    await createTestPerson({ id: "p1", email: "sender@out.com" });
    await seedInbox(MINE);

    const { res, body } = await listInboxes(apiKey);

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  it("matches inbox assignments case-insensitively", async () => {
    const { apiKey, userId } = await createMember();
    await createTestPerson({ id: "p1", email: "sender@out.com" });
    await seedInbox("Mixed@X.com");
    // Stored mixed-case from before insert-time canonicalization; the resolver
    // lowercases the grant, so the comparison has to fold the column too.
    await assign(userId, "mixed@x.com");

    const { body } = await listInboxes(apiKey);

    expect(body.map((r) => r.email)).toEqual(["Mixed@X.com"]);
  });

  it("carries the display name, mode and signature an inbox sends under", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await configure(MINE, {
      displayName: "Acme Support",
      displayMode: "thread",
      signatureHtml: "<p>— Acme</p>",
    });

    const { body } = await listInboxes(apiKey);

    expect(body).toEqual([
      {
        email: MINE,
        displayName: "Acme Support",
        displayMode: "thread",
        signatureHtml: "<p>— Acme</p>",
      },
    ]);
  });

  it("defaults an unconfigured inbox to chat, as the admin list does", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson({ id: "p1", email: "sender@out.com" });
    await seedInbox(MINE);

    const { body } = await listInboxes(apiKey);

    expect(body[0]).toMatchObject({ displayMode: "chat", displayName: null });
  });

  it("does not leak who else is assigned to an inbox", async () => {
    const { apiKey, userId } = await createMember("u-a");
    const other = await createMember("u-b");
    await createTestPerson({ id: "p1", email: "sender@out.com" });
    await seedInbox(MINE);
    await assign(userId, MINE);
    await assign(other.userId, MINE);

    const { body } = await listInboxes(apiKey);

    expect(body).toHaveLength(1);
    expect(Object.keys(body[0]).sort()).toEqual([
      "displayMode",
      "displayName",
      "email",
      "signatureHtml",
    ]);
  });

  /**
   * The contract that makes this route worth having: everything it lists is
   * something `POST /api/send` will accept, and nothing it omits is. A picker
   * built on a list that disagrees offers addresses that 403.
   */
  it("lists exactly the addresses the member may send from", async () => {
    const { apiKey, userId } = await createMember();
    await createTestPerson({ id: "p1", email: "sender@out.com" });
    await seedInbox(MINE);
    await seedInbox(OTHER);
    await assign(userId, MINE);

    const { body } = await listInboxes(apiKey);
    expect(body.map((r) => r.email)).toEqual([MINE]);

    const send = (fromAddress: string) => {
      const fd = new FormData();
      fd.append(
        "payload",
        JSON.stringify({
          to: "someone@out.com",
          fromAddress,
          subject: "Hi",
          bodyHtml: "<p>Hi</p>",
        }),
      );
      return authFetch("/api/send", { apiKey, method: "POST", body: fd });
    };

    expect((await send(OTHER)).status).toBe(403);
    expect((await send(MINE)).status).not.toBe(403);
  });

  it("requires authentication", async () => {
    const res = await authFetch("/api/inboxes");
    expect(res.status).toBe(401);
  });

  it("is classified as a read scope for OAuth callers", () => {
    // Unclassified routes are denied outright, so an unclassified /api/inboxes
    // would leave an OAuth client unable to discover any From address at all.
    expect(classifyRoute("GET", "/api/inboxes")).toEqual({
      kind: "scope",
      scope: "email:read",
    });
  });
});
