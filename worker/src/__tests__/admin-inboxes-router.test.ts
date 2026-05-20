import { beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { senderIdentities } from "../db/sender-identities.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { attachments } from "../db/attachments.schema";
import { people } from "../db/people.schema";
import { eq } from "drizzle-orm";

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("admin inboxes router", () => {
  it("lists inboxes from emails.recipient ∪ sender_identities", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "b@x.com",
      displayName: "Bee",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch("/api/admin/inboxes", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      email: string;
      displayName: string | null;
      assignedUserIds: string[];
    }>;
    const emails = body.map((b) => b.email).sort();
    expect(emails).toEqual(["a@x.com", "b@x.com"]);
  });

  it("returns 403 for non-admin caller", async () => {
    const { apiKey } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    const res = await authFetch("/api/admin/inboxes", { apiKey });
    expect(res.status).toBe(403);
  });

  it("PATCH upserts display name into sender_identities", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: "Alpha" }),
      },
    );
    expect(res.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows[0].displayName).toBe("Alpha");
  });

  it("PATCH clears display name when null is provided", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    // Inserts row at the new default (chat) so PATCH-to-null displayName
    // collapses to defaults and the row is removed.
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: "Alpha",
      displayMode: "chat",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: null }),
      },
    );
    expect(res.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows).toHaveLength(0);
  });

  it("GET returns displayMode (defaulting to 'chat' when no row)", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "b@x.com",
      displayName: "Bee",
      displayMode: "thread",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch("/api/admin/inboxes", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      email: string;
      displayName: string | null;
      displayMode: "thread" | "chat";
    }>;
    const byEmail = Object.fromEntries(body.map((b) => [b.email, b]));
    // a@x.com has no sender_identities row → falls back to default (chat).
    expect(byEmail["a@x.com"].displayMode).toBe("chat");
    // b@x.com has an explicit thread row → preserved.
    expect(byEmail["b@x.com"].displayMode).toBe("thread");
  });

  it("PATCH persists displayMode independently of displayName", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayMode: "thread" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      displayName: string | null;
      displayMode: "thread" | "chat";
    };
    expect(body.displayMode).toBe("thread");
    expect(body.displayName).toBeNull();
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows[0]?.displayMode).toBe("thread");
    expect(rows[0]?.displayName).toBeNull();
  });

  it("PATCH keeps the row when displayName=null but displayMode=thread", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: "Alpha",
      displayMode: "thread",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: null }),
      },
    );
    expect(res.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBeNull();
    expect(rows[0].displayMode).toBe("thread");
  });

  it("PATCH deletes the row when both fields are at defaults", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: "Alpha",
      displayMode: "thread",
      createdAt: now,
      updatedAt: now,
    });
    // Defaults are now displayName=null + displayMode=chat — patching back
    // to those values should sparse-delete the row.
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: null, displayMode: "chat" }),
      },
    );
    expect(res.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows).toHaveLength(0);
  });

  it("PATCH returns 400 when neither field is provided", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });

  it("PATCH persists signatureHtml and surfaces it in GET", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const sig = "<p>Cheers, the Acme team</p>";
    const patch = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ signatureHtml: sig }),
      },
    );
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as { signatureHtml: string | null };
    expect(patchBody.signatureHtml).toBe(sig);

    const list = await authFetch("/api/admin/inboxes", { apiKey });
    const rows = (await list.json()) as Array<{
      email: string;
      signatureHtml: string | null;
    }>;
    const row = rows.find((r) => r.email === "a@x.com");
    expect(row?.signatureHtml).toBe(sig);
  });

  it("PATCH sanitizes hostile signatureHtml before storage", async () => {
    // Wiring test for the sanitize-signature layer. Full coverage of
    // the sanitizer's strip rules lives in sanitize-signature.test.ts;
    // here we just assert the route actually calls it — protects
    // against someone unwiring sanitization in a future refactor.
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const hostile =
      '<p onclick="alert(1)">hi</p>' +
      "<script>alert(2)</script>" +
      '<a href="javascript:alert(3)">x</a>';
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ signatureHtml: hostile }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signatureHtml: string | null };
    expect(body.signatureHtml).not.toMatch(/<script/i);
    expect(body.signatureHtml).not.toMatch(/\bon\w+\s*=/i);
    expect(body.signatureHtml).not.toMatch(/href\s*=\s*"javascript:/i);
    // Benign content survives.
    expect(body.signatureHtml).toContain("<p>hi</p>");
  });

  it("PATCH rejects signatureHtml longer than the cap", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    // One byte over the cap is enough — zod fails the schema.
    const tooLong = "<p>" + "x".repeat(20_001) + "</p>";
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ signatureHtml: tooLong }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("PATCH with signatureHtml='' clears the stored signature", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: "Alpha",
      displayMode: "thread",
      signatureHtml: "<p>old</p>",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ signatureHtml: "" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signatureHtml: string | null };
    expect(body.signatureHtml).toBeNull();
  });

  it("PATCH only deletes the row when ALL fields are at defaults", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    // Row with only a signature configured — display fields at defaults.
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: null,
      displayMode: "chat",
      signatureHtml: "<p>sig</p>",
      createdAt: now,
      updatedAt: now,
    });
    // Patching the display fields back to defaults should NOT sparse-delete
    // the row, because the signature is still set.
    await authFetch(`/api/admin/inboxes/${encodeURIComponent("a@x.com")}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ displayName: null, displayMode: "chat" }),
    });
    const stillThere = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].signatureHtml).toBe("<p>sig</p>");
  });

  it("PUT assignments replaces the full member set", async () => {
    const { apiKey } = await createTestUser({
      id: "u-admin",
      role: "admin",
      email: "admin@x.com",
    });
    await createTestUser({ id: "u-m1", role: "member", email: "m1@x.com" });
    await createTestUser({ id: "u-m2", role: "member", email: "m2@x.com" });
    await createTestUser({ id: "u-m3", role: "member", email: "m3@x.com" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(inboxPermissions).values({
      userId: "u-m3",
      email: "a@x.com",
      createdAt: now,
      createdBy: "u-admin",
    });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}/assignments`,
      {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ userIds: ["u-m1", "u-m2"] }),
      },
    );
    expect(res.status).toBe(200);

    const rows = await getDb()
      .select()
      .from(inboxPermissions)
      .where(eq(inboxPermissions.email, "a@x.com"));
    const userIds = rows.map((r) => r.userId).sort();
    expect(userIds).toEqual(["u-m1", "u-m2"]);
  });

  it("DELETE returns 404 when no trace of the inbox exists anywhere", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("ghost@x.com")}`,
      { apiKey, method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("DELETE wipes auto-discovered inbox (received emails only)", async () => {
    // Regression: an inbox that only exists because emails were received
    // for it (no sender_identity row, no permissions) used to 404. It
    // should now succeed and the inbox should disappear from the list.
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({
      id: "e1",
      recipient: "drop@x.com",
      messageId: "m1@x",
    });
    await createTestEmail({
      id: "e2",
      recipient: "drop@x.com",
      messageId: "m2@x",
    });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("drop@x.com")}`,
      { apiKey, method: "DELETE" },
    );
    expect(res.status).toBe(200);

    const remaining = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.recipient, "drop@x.com"));
    expect(remaining).toHaveLength(0);
  });

  it("DELETE cascades to attachments and sent_emails", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ id: "e1", recipient: "ops@x.com" });

    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(attachments).values({
      id: "att-1",
      emailId: "e1",
      kind: "inbound",
      filename: "f.pdf",
      contentType: "application/pdf",
      size: 100,
      r2Key: "attachments/e1/att-1/f.pdf",
      createdAt: now,
    });
    await getDb().insert(sentEmails).values({
      id: "s-1",
      personId: "sender-1",
      fromAddress: "ops@x.com",
      toAddress: "customer@example.com",
      subject: "hi",
      sentAt: now,
      createdAt: now,
    });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("ops@x.com")}`,
      { apiKey, method: "DELETE" },
    );
    expect(res.status).toBe(200);

    const attRows = await getDb()
      .select()
      .from(attachments)
      .where(eq(attachments.emailId, "e1"));
    expect(attRows).toHaveLength(0);

    const sentRows = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.fromAddress, "ops@x.com"));
    expect(sentRows).toHaveLength(0);
  });

  it("DELETE decrements people counts and never goes below zero", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(people).values({
      id: "p-1",
      email: "alice@example.com",
      totalCount: 3,
      unreadCount: 2,
      lastEmailAt: now,
      createdAt: now,
      updatedAt: now,
    });
    // Two emails to-be-deleted (one unread), one email at a different
    // recipient that must NOT affect counts.
    await createTestEmail({
      id: "e1",
      personId: "p-1",
      recipient: "killme@x.com",
      isRead: 0,
      messageId: "m1@x",
    });
    await createTestEmail({
      id: "e2",
      personId: "p-1",
      recipient: "killme@x.com",
      isRead: 1,
      messageId: "m2@x",
    });
    await createTestEmail({
      id: "e3",
      personId: "p-1",
      recipient: "keep@x.com",
      isRead: 0,
      messageId: "m3@x",
    });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("killme@x.com")}`,
      { apiKey, method: "DELETE" },
    );
    expect(res.status).toBe(200);

    const [updated] = await getDb()
      .select()
      .from(people)
      .where(eq(people.id, "p-1"));
    // totalCount was 3, minus the 2 deleted -> 1.
    // unreadCount was 2, minus the 1 unread deleted -> 1.
    expect(updated.totalCount).toBe(1);
    expect(updated.unreadCount).toBe(1);
  });

  it("DELETE still removes a configured inbox (sender_identity path)", async () => {
    // Existing behavior must continue to work.
    const { apiKey } = await createTestUser({
      id: "u-admin",
      role: "admin",
      email: "admin@x.com",
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "named@x.com",
      displayName: "Named",
      createdAt: now,
      updatedAt: now,
    });
    await getDb().insert(inboxPermissions).values({
      email: "named@x.com",
      userId: "u-admin",
      createdAt: now,
    });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("named@x.com")}`,
      { apiKey, method: "DELETE" },
    );
    expect(res.status).toBe(200);

    const id = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "named@x.com"));
    const perm = await getDb()
      .select()
      .from(inboxPermissions)
      .where(eq(inboxPermissions.email, "named@x.com"));
    expect(id).toHaveLength(0);
    expect(perm).toHaveLength(0);
  });
});
