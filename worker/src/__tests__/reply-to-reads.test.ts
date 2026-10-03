// SPEC-reply-to §2: Reply-To on the read side. The unified query carries the
// list when asked, and the HTTP routes return where a reply would go: the list
// minus our own inboxes.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { senderIdentities } from "../db/sender-identities.schema";
import { queryMessages } from "../lib/messages/query";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import {
  replyCandidates,
  replyRecipients,
  replyTarget,
} from "../lib/reply-recipients";
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

const INBOX = "support@saasmail.test";
const OTHER_INBOX = "billing@saasmail.test";
const ADMIN = { isAdmin: true as const };

const list = (...emails: string[]) =>
  JSON.stringify(emails.map((email) => ({ email, name: null })));

describe("replyCandidates", () => {
  const own = new Set([INBOX, OTHER_INBOX]);

  it("drops our own inboxes, whatever their case", () => {
    expect(
      replyCandidates(
        [
          { email: "Billing@SaaSMail.test" },
          { email: "help@acme.com", name: "Acme" },
        ],
        own,
      ),
    ).toEqual([{ email: "help@acme.com", name: "Acme" }]);
  });

  it("drops the inbox the reply is sent from, even when it is not listed", () => {
    expect(
      replyCandidates(
        [{ email: "alias@saasmail.test" }, { email: "help@acme.com" }],
        own,
        "Alias@saasmail.test",
      ),
    ).toEqual([{ email: "help@acme.com" }]);
  });

  it("is empty when every address is ours", () => {
    expect(replyCandidates([{ email: INBOX }], own)).toEqual([]);
  });
});

describe("replyTarget", () => {
  it("is the first candidate when it is not the sender", () => {
    expect(
      replyTarget(
        [{ email: "help@acme.com" }, { email: "b@acme.com" }],
        "noreply@acme.com",
      ),
    ).toBe("help@acme.com");
  });

  it("is null when the first candidate is the sender, or there is none", () => {
    expect(replyTarget([{ email: "a@acme.com" }], "A@acme.com")).toBeNull();
    expect(replyTarget([], "a@acme.com")).toBeNull();
  });
});

describe("replyRecipients", () => {
  it("is the candidates, in order", () => {
    expect(
      replyRecipients(
        [{ email: "help@acme.com" }, { email: "b@acme.com" }],
        "noreply@acme.com",
      ),
    ).toEqual([{ email: "help@acme.com" }, { email: "b@acme.com" }]);
  });

  it("is empty when the reply simply goes to the sender", () => {
    expect(replyRecipients([], "a@acme.com")).toEqual([]);
    expect(replyRecipients([{ email: "A@acme.com" }], "a@acme.com")).toEqual(
      [],
    );
  });

  it("keeps the sender when others are copied alongside it", () => {
    expect(
      replyRecipients(
        [{ email: "a@acme.com" }, { email: "desk@acme.com" }],
        "a@acme.com",
      ),
    ).toEqual([{ email: "a@acme.com" }, { email: "desk@acme.com" }]);
  });
});

describe("Reply-To reads", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(senderIdentities)
      .values(
        [INBOX, OTHER_INBOX].map((email) => ({
          email,
          createdAt: now,
          updatedAt: now,
        })),
      );
    await createTestPerson({ id: "p1", email: "noreply@acme.com" });
  });

  describe("queryMessages", () => {
    it("leaves replyTo out unless asked", async () => {
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: INBOX,
        replyTo: list("help@acme.com"),
      });
      const page = await queryMessages(getDb(), ADMIN, {});
      expect(page.messages).toHaveLength(1);
      expect("replyTo" in page.messages[0]).toBe(false);
    });

    it("returns the stored list, the raw_headers fallback, and [] for none", async () => {
      await createTestEmail({
        id: "stored",
        personId: "p1",
        recipient: INBOX,
        messageId: "stored@acme.com",
        replyTo: list("help@acme.com", "b@acme.com"),
      });
      await createTestEmail({
        id: "legacy",
        personId: "p1",
        recipient: INBOX,
        messageId: "legacy@acme.com",
        rawHeaders: JSON.stringify({
          "reply-to": "Old Desk <Desk@Acme.com>",
        }),
      });
      await createTestEmail({
        id: "none",
        personId: "p1",
        recipient: INBOX,
        messageId: "none@acme.com",
      });
      await createTestEmail({
        id: "broken",
        personId: "p1",
        recipient: INBOX,
        messageId: "broken@acme.com",
        rawHeaders: "not json",
      });

      const page = await queryMessages(getDb(), ADMIN, { withReplyTo: true });
      const byId = new Map(page.messages.map((m) => [m.ref.id, m.replyTo]));
      expect(byId.get("stored")).toEqual([
        { email: "help@acme.com", name: null },
        { email: "b@acme.com", name: null },
      ]);
      expect(byId.get("legacy")).toEqual([
        { email: "desk@acme.com", name: "Old Desk" },
      ]);
      expect(byId.get("none")).toEqual([]);
      expect(byId.get("broken")).toEqual([]);
    });

    it("gives sent mail an empty list", async () => {
      await createTestSentEmail({
        id: "s1",
        personId: "p1",
        fromAddress: INBOX,
        toAddress: "noreply@acme.com",
      });
      const page = await queryMessages(getDb(), ADMIN, { withReplyTo: true });
      expect(page.messages[0].replyTo).toEqual([]);
    });
  });

  describe("GET /api/messages", () => {
    it("returns the addresses a reply would use, without our own inboxes", async () => {
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: INBOX,
        replyTo: list(OTHER_INBOX, "help@acme.com"),
      });
      const res = await authFetch(`/api/messages?inbox=${INBOX}`, { apiKey });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: { ref: string; replyTo?: { email: string }[] }[];
      };
      expect(body.messages[0].replyTo).toEqual([
        { email: "help@acme.com", name: null },
      ]);
    });
  });

  describe("GET /api/messages for a member", () => {
    it("drops an inbox of ours the member was never granted", async () => {
      const member = await createTestUser({
        id: "reply-to-member",
        email: "reply-to-member@example.com",
        role: "member",
      });
      await getDb()
        .insert(inboxPermissions)
        .values({
          userId: member.userId,
          email: INBOX,
          createdAt: Math.floor(Date.now() / 1000),
          createdBy: null,
        });
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: INBOX,
        replyTo: list(OTHER_INBOX, "help@acme.com"),
      });

      const res = await authFetch(`/api/messages?inbox=${INBOX}`, {
        apiKey: member.apiKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: { replyTo?: { email: string }[] }[];
      };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].replyTo).toEqual([
        { email: "help@acme.com", name: null },
      ]);
    });
  });

  describe("what a reply would use", () => {
    it("is empty when the Reply-To only repeats the sender", async () => {
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: INBOX,
        replyTo: list("NoReply@acme.com"),
      });

      const listed = (await (
        await authFetch(`/api/messages?inbox=${INBOX}`, { apiKey })
      ).json()) as { messages: { replyTo?: unknown[] }[] };
      expect(listed.messages[0].replyTo).toEqual([]);

      const detail = (await (
        await authFetch("/api/emails/e1", { apiKey })
      ).json()) as { replyTo: string | null; replyRecipients: unknown[] };
      expect(detail.replyTo).toBeNull();
      expect(detail.replyRecipients).toEqual([]);
    });

    it("names an address that is copied next to the sender", async () => {
      // The reply goes To the sender and Cc desk@: the reader must see desk@.
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: INBOX,
        replyTo: list("noreply@acme.com", "desk@acme.com"),
      });
      const expected = [
        { email: "noreply@acme.com", name: null },
        { email: "desk@acme.com", name: null },
      ];

      const listed = (await (
        await authFetch(`/api/messages?inbox=${INBOX}`, { apiKey })
      ).json()) as { messages: { replyTo?: unknown[] }[] };
      expect(listed.messages[0].replyTo).toEqual(expected);

      const detail = (await (
        await authFetch("/api/emails/e1", { apiKey })
      ).json()) as { replyTo: string | null; replyRecipients: unknown[] };
      // The single address is for "who else to reply to": not the sender.
      expect(detail.replyTo).toBeNull();
      expect(detail.replyRecipients).toEqual(expected);
    });

    it("never names the inbox the message arrived at", async () => {
      // An address we receive at without an inbox row: the send-time guard
      // refuses it as the From of the reply, so reads must not offer it.
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: "alias@saasmail.test",
        replyTo: list("alias@saasmail.test"),
      });

      const listed = (await (
        await authFetch("/api/messages?inbox=alias@saasmail.test", { apiKey })
      ).json()) as { messages: { replyTo?: unknown[] }[] };
      expect(listed.messages[0].replyTo).toEqual([]);

      const detail = (await (
        await authFetch("/api/emails/e1", { apiKey })
      ).json()) as { replyTo: string | null; replyRecipients: unknown[] };
      expect(detail.replyTo).toBeNull();
      expect(detail.replyRecipients).toEqual([]);
    });
  });

  describe("GET /api/emails/{id}", () => {
    it("prefers the stored list over raw_headers", async () => {
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: INBOX,
        replyTo: list("help@acme.com"),
        rawHeaders: JSON.stringify({ "reply-to": "stale@acme.com" }),
      });
      const res = await authFetch("/api/emails/e1", { apiKey });
      const data = (await res.json()) as { replyTo: string | null };
      expect(data.replyTo).toBe("help@acme.com");
    });

    it("skips a Reply-To that is one of our inboxes", async () => {
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: INBOX,
        replyTo: list(OTHER_INBOX),
      });
      const res = await authFetch("/api/emails/e1", { apiKey });
      const data = (await res.json()) as { replyTo: string | null };
      expect(data.replyTo).toBeNull();
    });
  });

  describe("timeline routes", () => {
    it("GET /api/emails/by-person/{personId} fills replyTo on received mail", async () => {
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: INBOX,
        replyTo: list("help@acme.com"),
      });
      await createTestSentEmail({
        id: "s1",
        personId: "p1",
        fromAddress: INBOX,
        toAddress: "noreply@acme.com",
      });
      const res = await authFetch("/api/emails/by-person/p1", { apiKey });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        emails: {
          id: string;
          replyTo: string | null;
          replyRecipients: { email: string }[];
        }[];
      };
      const byId = new Map(data.emails.map((e) => [e.id, e]));
      expect(byId.get("e1")?.replyTo).toBe("help@acme.com");
      expect(byId.get("e1")?.replyRecipients).toEqual([
        { email: "help@acme.com", name: null },
      ]);
      expect(byId.get("s1")?.replyTo).toBeNull();
      expect(byId.get("s1")?.replyRecipients).toEqual([]);
    });

    it("GET /api/conversations/{id}/emails fills replyTo on received mail", async () => {
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: INBOX,
        conversationId: "conv-1",
        replyTo: list("help@acme.com"),
      });
      const res = await authFetch("/api/conversations/conv-1/emails", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        emails: {
          id: string;
          replyTo: string | null;
          replyRecipients: { email: string }[];
        }[];
      };
      expect(data.emails[0].replyTo).toBe("help@acme.com");
      expect(data.emails[0].replyRecipients).toEqual([
        { email: "help@acme.com", name: null },
      ]);
    });
  });
});
