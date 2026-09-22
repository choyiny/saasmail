import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { createMailbox, setMailboxMembership } from "../lib/messages/state";

const INBOX = "support@saasmail.test";

describe("message state routes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  async function admin() {
    return createTestUser({
      id: "route-admin",
      email: "route-admin@example.com",
    });
  }

  it("lists messages with serialized refs and sent campaign exclusion defaults", async () => {
    const { apiKey } = await admin();
    await createTestPerson({ id: "route-person", email: "route@example.com" });
    await createTestSentEmail({
      id: "ordinary-send",
      personId: "route-person",
      fromAddress: INBOX,
      toAddress: "route@example.com",
    });
    await createTestSentEmail({
      id: "campaign-send",
      personId: "route-person",
      fromAddress: INBOX,
      toAddress: "route@example.com",
      campaignId: "campaign-1",
    });

    let res = await authFetch("/api/messages?folder=sent", { apiKey });
    expect(res.status).toBe(200);
    let body = (await res.json()) as { messages: Array<{ ref: string }> };
    expect(body.messages.map((message) => message.ref)).toEqual([
      "sent:ordinary-send",
    ]);

    res = await authFetch(
      "/api/messages?folder=sent&excludeCampaignSends=false",
      { apiKey },
    );
    expect(res.status).toBe(200);
    body = (await res.json()) as { messages: Array<{ ref: string }> };
    expect(body.messages.map((message) => message.ref).sort()).toEqual(
      ["sent:ordinary-send", "sent:campaign-send"].sort(),
    );
  });

  it("returns 404 for a custom mailbox outside a member's inboxes", async () => {
    const owner = await admin();
    const member = await createTestUser({
      id: "route-member",
      role: "member",
      email: "route-member@example.com",
    });
    await getDb().insert(inboxPermissions).values({
      userId: member.userId,
      email: "other@saasmail.test",
      createdAt: 1,
      createdBy: owner.userId,
    });
    const mailbox = await createMailbox(
      getDb(),
      { isAdmin: true },
      owner.userId,
      { inbox: INBOX, name: "Private" },
    );

    const res = await authFetch(
      `/api/messages?mailboxId=${encodeURIComponent(mailbox.id)}`,
      { apiKey: member.apiKey },
    );
    expect(res.status).toBe(404);
  });

  it("maps invalid cursor/state to 400 and missing refs to 404", async () => {
    const { apiKey } = await admin();
    let res = await authFetch("/api/messages?cursor=not-a-cursor", { apiKey });
    expect(res.status).toBe(400);

    await createTestSentEmail({
      id: "route-sent",
      fromAddress: INBOX,
      toAddress: "someone@example.com",
    });
    res = await authFetch("/api/messages/mailbox-state", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        refs: ["sent:route-sent"],
        archived: true,
      }),
    });
    expect(res.status).toBe(400);

    res = await authFetch("/api/messages/user-state", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        refs: ["received:missing"],
        starred: true,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects 501 message refs", async () => {
    const { apiKey } = await admin();
    const refs = Array.from({ length: 501 }, (_, index) => `received:${index}`);
    const res = await authFetch("/api/messages/user-state", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ refs, starred: true }),
    });
    expect(res.status).toBe(400);
  });

  it("supports message state and mailbox membership mutations", async () => {
    const { apiKey, userId } = await admin();
    await createTestPerson({ id: "mut-person", email: "mut@example.com" });
    await createTestEmail({
      id: "mut-message",
      personId: "mut-person",
      recipient: INBOX,
      messageId: "mut@example.com",
    });
    const mailbox = await createMailbox(getDb(), { isAdmin: true }, userId, {
      inbox: INBOX,
      name: "Projects",
    });

    expect(
      (
        await authFetch("/api/messages/user-state", {
          apiKey,
          method: "POST",
          body: JSON.stringify({
            refs: ["received:mut-message"],
            starred: true,
            seen: true,
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await authFetch("/api/messages/mailbox-state", {
          apiKey,
          method: "POST",
          body: JSON.stringify({
            refs: ["received:mut-message"],
            archived: true,
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await authFetch("/api/messages/mailbox-membership", {
          apiKey,
          method: "POST",
          body: JSON.stringify({
            refs: ["received:mut-message"],
            add: [mailbox.id],
          }),
        })
      ).status,
    ).toBe(200);

    const list = await authFetch("/api/messages?mailboxId=" + mailbox.id, {
      apiKey,
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      messages: Array<{
        ref: string;
        state?: {
          starredAt: number | null;
          archivedAt: number | null;
          mailboxIds: string[];
        };
      }>;
    };
    expect(body.messages[0].ref).toBe("received:mut-message");
    expect(body.messages[0].state?.starredAt).not.toBeNull();
    expect(body.messages[0].state?.archivedAt).not.toBeNull();
    expect(body.messages[0].state?.mailboxIds).toContain(mailbox.id);
  });

  it("implements mailbox CRUD and duplicate-name conflicts", async () => {
    const { apiKey } = await admin();
    let res = await authFetch("/api/mailboxes", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ inbox: INBOX, name: "Projects" }),
    });
    expect(res.status).toBe(200);
    const mailbox = (await res.json()) as { id: string; name: string };

    res = await authFetch("/api/mailboxes", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ inbox: INBOX, name: "Projects" }),
    });
    expect(res.status).toBe(409);

    res = await authFetch(`/api/mailboxes/${mailbox.id}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed", sortOrder: 7 }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { name: string; sortOrder: number };
    expect(updated).toMatchObject({ name: "Renamed", sortOrder: 7 });

    res = await authFetch("/api/mailboxes?inbox=" + encodeURIComponent(INBOX), {
      apiKey,
    });
    expect(res.status).toBe(200);
    const listed = (await res.json()) as {
      mailboxes: Array<{ id: string; name: string }>;
    };
    expect(listed.mailboxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: mailbox.id, name: "Renamed" }),
      ]),
    );

    res = await authFetch(`/api/mailboxes/${mailbox.id}`, {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
  });

  it("rejects folder and mailboxId together as an invalid query", async () => {
    const { apiKey, userId } = await admin();
    const mailbox = await createMailbox(getDb(), { isAdmin: true }, userId, {
      inbox: INBOX,
      name: "Custom",
    });
    const res = await authFetch(
      `/api/messages?folder=inbox&mailboxId=${mailbox.id}`,
      { apiKey },
    );
    expect(res.status).toBe(400);
  });

  it("applies mailbox membership only to matching messages", async () => {
    const { apiKey, userId } = await admin();
    await createTestPerson({
      id: "member-person",
      email: "member@example.com",
    });
    await createTestEmail({
      id: "member-message",
      personId: "member-person",
      recipient: INBOX,
      messageId: "member-message@example.com",
    });
    const mailbox = await createMailbox(getDb(), { isAdmin: true }, userId, {
      inbox: INBOX,
      name: "Membership",
    });
    await setMailboxMembership(
      getDb(),
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "member-message" }],
      { add: [mailbox.id] },
    );

    const res = await authFetch("/api/messages?mailboxId=" + mailbox.id, {
      apiKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ ref: string }> };
    expect(body.messages.map((message) => message.ref)).toEqual([
      "received:member-message",
    ]);
  });
  it("snoozes conversations through the API and lists the snoozed folder", async () => {
    const { apiKey } = await admin();
    await createTestPerson({
      id: "route-snooze-person",
      email: "route-snooze@example.com",
    });
    await createTestEmail({
      id: "route-snooze-a",
      personId: "route-snooze-person",
      recipient: INBOX,
      messageId: "route-snooze-a@example.com",
    });
    await createTestEmail({
      id: "route-snooze-b",
      personId: "route-snooze-person",
      recipient: INBOX,
      messageId: "route-snooze-b@example.com",
    });

    const until = Math.floor(Date.now() / 1000) + 3600;
    let res = await authFetch("/api/messages/snooze", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        refs: ["received:route-snooze-a"],
        until,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: 1 });

    res = await authFetch(
      `/api/messages?folder=snoozed&inbox=${encodeURIComponent(INBOX)}`,
      { apiKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        ref: string;
        state?: { conversationKey: string | null; snoozedUntil: number | null };
      }>;
    };
    expect(body.messages.map((message) => message.ref).sort()).toEqual([
      "received:route-snooze-a",
      "received:route-snooze-b",
    ]);
    expect(
      body.messages.every(
        (message) =>
          message.state?.conversationKey === "p:route-snooze-person" &&
          message.state.snoozedUntil === until,
      ),
    ).toBe(true);

    res = await authFetch("/api/messages/snooze", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        refs: ["received:route-snooze-a"],
        until: null,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: 1 });
  });

  it("rejects invalid snooze times and messages without a conversation key", async () => {
    const { apiKey } = await admin();
    await createTestSentEmail({
      id: "route-no-key",
      personId: null,
      fromAddress: INBOX,
      toAddress: "campaign-contact@example.com",
      conversationId: null,
    });
    const now = Math.floor(Date.now() / 1000);

    for (const until of [now, now + 367 * 24 * 60 * 60]) {
      const res = await authFetch("/api/messages/snooze", {
        apiKey,
        method: "POST",
        body: JSON.stringify({ refs: ["sent:route-no-key"], until }),
      });
      expect(res.status).toBe(400);
    }

    const res = await authFetch("/api/messages/snooze", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        refs: ["sent:route-no-key"],
        until: now + 60,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when a member snoozes a message outside their inboxes", async () => {
    const member = await createTestUser({
      id: "route-snooze-member",
      role: "member",
      email: "route-snooze-member@example.com",
    });
    await createTestPerson({
      id: "route-private-person",
      email: "route-private@example.com",
    });
    await createTestEmail({
      id: "route-private-message",
      personId: "route-private-person",
      recipient: INBOX,
      messageId: "route-private-message@example.com",
    });

    const res = await authFetch("/api/messages/snooze", {
      apiKey: member.apiKey,
      method: "POST",
      body: JSON.stringify({
        refs: ["received:route-private-message"],
        until: Math.floor(Date.now() / 1000) + 60,
      }),
    });
    expect(res.status).toBe(404);
  });
});
