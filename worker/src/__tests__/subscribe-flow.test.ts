import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { contacts } from "../db/contacts.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { people } from "../db/people.schema";
import { subscribeAttempts } from "../db/subscribe-attempts.schema";
import { subscribeForms } from "../db/subscribe-forms.schema";
import {
  buildConfirmUrl,
  buildConfirmationContent,
  signConfirmToken,
} from "../lib/subscribe-confirmation";
import { emailTemplates } from "../db/email-templates.schema";
import {
  ATTEMPT_RETENTION_SECONDS,
  isOriginAllowed,
  purgeExpiredAttempts,
} from "../lib/subscribe-abuse";
import { runNewsletterMaintenance } from "../lib/newsletter-cron";
import { env } from "cloudflare:workers";

beforeAll(applyMigrations);
beforeEach(cleanDb);

const FROM = "news@example.com";
const SECRET = "test-secret-do-not-use-in-prod";

async function adminKey() {
  const { apiKey } = await createTestUser({
    id: "u-admin",
    role: "admin",
    email: "admin@example.com",
  });
  return apiKey;
}

async function seedList(doubleOptIn = false) {
  const ts = Math.floor(Date.now() / 1000);
  const id = `list-${doubleOptIn ? "doi" : "soi"}`;
  await getDb()
    .insert(lists)
    .values({
      id,
      name: "Weekly",
      description: null,
      fromAddress: FROM,
      doubleOptIn: doubleOptIn ? 1 : 0,
      confirmationTemplateSlug: null,
      archivedAt: null,
      createdAt: ts,
      updatedAt: ts,
    });
  return id;
}

async function seedForm(listId: string, overrides: Record<string, any> = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const id = overrides.id ?? "form-1";
  await getDb()
    .insert(subscribeForms)
    .values({
      id,
      listId,
      name: "Signup",
      showNameField: 1,
      nameRequired: 0,
      successMessage: "Thanks!",
      redirectUrl: null,
      allowedOrigins: null,
      createdAt: ts,
      updatedAt: ts,
      ...overrides,
    });
  return id;
}

/** Post to the public endpoint the way an embedded HTML form would. */
function submit(
  formId: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return authFetch(`/subscribe/${formId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": "203.0.113.5",
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("isOriginAllowed", () => {
  it("allows any origin when none are configured", () => {
    expect(isOriginAllowed(null, null)).toBe(true);
    expect(isOriginAllowed("", "https://x.com")).toBe(true);
  });

  it("matches a configured origin case-insensitively", () => {
    expect(
      isOriginAllowed("https://a.com,https://b.com", "https://B.com"),
    ).toBe(true);
  });

  /**
   * The control has to fail closed. Treating a missing Origin as "allowed"
   * would let any non-browser client — exactly what an abuser uses — skip it.
   */
  it("rejects a missing Origin when origins are configured", () => {
    expect(isOriginAllowed("https://a.com", null)).toBe(false);
  });

  it("rejects a non-matching origin", () => {
    expect(isOriginAllowed("https://a.com", "https://evil.com")).toBe(false);
  });
});

describe("public subscribe — single opt-in", () => {
  it("subscribes immediately and creates a contact but no person", async () => {
    const listId = await seedList(false);
    const formId = await seedForm(listId);

    const res = await submit(formId, { email: "Sub@Example.com", name: "Sub" });
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toMatchObject({ status: "subscribed" });

    const members = await getDb().select().from(listMembers);
    expect(members).toHaveLength(1);
    expect(members[0].status).toBe("subscribed");
    expect(members[0].source).toBe("form");
    expect(members[0].consentSource).toBe("form");
    expect(members[0].formId).toBe(formId);
    expect(members[0].submittedIp).toBe("203.0.113.5");

    expect(await getDb().select().from(contacts)).toHaveLength(1);
    expect(await getDb().select().from(people)).toHaveLength(0);
  });

  it("is idempotent for an already-subscribed address", async () => {
    const listId = await seedList(false);
    const formId = await seedForm(listId);
    await submit(formId, { email: "a@example.com" });
    const second = await submit(formId, { email: "a@example.com" });

    expect(second.status).toBe(200);
    expect(await getDb().select().from(listMembers)).toHaveLength(1);
  });

  it("rejects an invalid address with 422", async () => {
    const listId = await seedList(false);
    const formId = await seedForm(listId);
    const res = await submit(formId, { email: "not-an-email" });
    expect(res.status).toBe(422);
    expect(await getDb().select().from(listMembers)).toHaveLength(0);
  });

  it("requires a name when the form says so", async () => {
    const listId = await seedList(false);
    const formId = await seedForm(listId, { nameRequired: 1 });
    const res = await submit(formId, { email: "a@example.com" });
    expect(res.status).toBe(422);
  });
});

describe("public subscribe — abuse controls", () => {
  it("silently accepts and ignores a filled honeypot", async () => {
    const listId = await seedList(false);
    const formId = await seedForm(listId);

    const res = await submit(formId, {
      email: "bot@example.com",
      _hp: "i am a bot",
    });
    // Looks exactly like success, so the bot learns nothing...
    expect(res.status).toBe(200);
    // ...but nothing was written.
    expect(await getDb().select().from(listMembers)).toHaveLength(0);
    expect(await getDb().select().from(contacts)).toHaveLength(0);
  });

  it("refuses an oversized body before parsing it", async () => {
    const listId = await seedList(false);
    const formId = await seedForm(listId);
    const res = await submit(formId, {
      email: "a@example.com",
      pad: "x".repeat(5000),
    });
    expect(res.status).toBe(413);
  });

  it("rejects a request whose Origin is not allowed, generically", async () => {
    const listId = await seedList(false);
    const formId = await seedForm(listId, {
      allowedOrigins: "https://mysite.com",
    });

    const res = await submit(
      formId,
      { email: "a@example.com" },
      { Origin: "https://evil.com" },
    );
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    // Same message an unknown form gives, so the endpoint is not an oracle.
    expect(body.error).toBe("Unable to process this subscription.");
  });

  it("gives an unknown form the same generic rejection", async () => {
    const res = await submit("no-such-form", { email: "a@example.com" });
    expect(res.status).toBe(403);
    expect((await res.json<any>()).error).toBe(
      "Unable to process this subscription.",
    );
  });

  it("rate-limits an IP after 10 submissions in the window", async () => {
    const listId = await seedList(false);
    const formId = await seedForm(listId);

    for (let i = 0; i < 10; i++) {
      const r = await submit(formId, { email: `u${i}@example.com` });
      expect(r.status).toBe(200);
    }
    const blocked = await submit(formId, { email: "eleventh@example.com" });
    expect(blocked.status).toBe(429);
  });

  /**
   * The reason `subscribe_attempts` exists. Repeated submissions against an
   * already-pending membership are upserts that change no `list_members` row,
   * so a membership count sees nothing while the victim keeps getting mail.
   */
  it("records an attempt even when the submission changes no membership row", async () => {
    const listId = await seedList(true);
    const formId = await seedForm(listId);

    await submit(formId, { email: "target@example.com" });
    await submit(formId, { email: "target@example.com" });

    expect(await getDb().select().from(listMembers)).toHaveLength(1);
    const attempts = await getDb()
      .select()
      .from(subscribeAttempts)
      .where(eq(subscribeAttempts.attemptType, "submission"));
    expect(attempts).toHaveLength(2);
  });

  it("stores only a hash of the address in the attempts ledger", async () => {
    const listId = await seedList(false);
    const formId = await seedForm(listId);
    await submit(formId, { email: "private@example.com" });

    const rows = await getDb().select().from(subscribeAttempts);
    expect(rows).toHaveLength(1);
    expect(rows[0].emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain("private@example.com");
  });

  it("caps confirmation resends per address per form", async () => {
    const listId = await seedList(true);
    const formId = await seedForm(listId);

    for (let i = 0; i < 4; i++) {
      await submit(formId, { email: "loop@example.com" });
    }
    const resends = await getDb()
      .select()
      .from(subscribeAttempts)
      .where(eq(subscribeAttempts.attemptType, "confirmation_resend"));
    // Capped at 2 even though 4 submissions were accepted.
    expect(resends).toHaveLength(2);
  });
});

describe("public subscribe — double opt-in", () => {
  it("creates a pending membership and reports pending", async () => {
    const listId = await seedList(true);
    const formId = await seedForm(listId);

    const res = await submit(formId, { email: "doi@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toMatchObject({ status: "pending" });

    const members = await getDb().select().from(listMembers);
    expect(members[0].status).toBe("pending");
    expect(members[0].subscribedAt).toBeNull();
    expect(members[0].confirmedAt).toBeNull();
  });

  it("confirms via a valid token and is idempotent on replay", async () => {
    const listId = await seedList(true);
    const formId = await seedForm(listId);
    await submit(formId, { email: "doi@example.com" });

    const contact = (await getDb().select().from(contacts))[0];
    const token = await signConfirmToken(
      { formId, listId, contactId: contact.id },
      SECRET,
      Math.floor(Date.now() / 1000),
    );

    const first = await authFetch(`/subscribe/confirm/${token}`);
    expect(first.status).toBe(200);
    let member = (await getDb().select().from(listMembers))[0];
    expect(member.status).toBe("subscribed");
    expect(member.confirmedAt).not.toBeNull();
    const firstConfirmedAt = member.confirmedAt;

    // A pre-fetching mail client or a double click must not error, and must not
    // rewrite the original confirmation timestamp.
    const replay = await authFetch(`/subscribe/confirm/${token}`);
    expect(replay.status).toBe(200);
    member = (await getDb().select().from(listMembers))[0];
    expect(member.confirmedAt).toBe(firstConfirmedAt);
  });

  it("returns 410 for an expired token so the subscriber knows to retry", async () => {
    const listId = await seedList(true);
    const formId = await seedForm(listId);
    await submit(formId, { email: "doi@example.com" });
    const contact = (await getDb().select().from(contacts))[0];

    // Sign with a timestamp far enough in the past that exp has passed.
    const token = await signConfirmToken(
      { formId, listId, contactId: contact.id },
      SECRET,
      Math.floor(Date.now() / 1000) - 49 * 3600,
    );

    const res = await authFetch(`/subscribe/confirm/${token}`);
    expect(res.status).toBe(410);
    expect((await getDb().select().from(listMembers))[0].status).toBe(
      "pending",
    );
  });

  it("rejects a garbage token with 400", async () => {
    const res = await authFetch("/subscribe/confirm/not-a-real-token");
    expect(res.status).toBe(400);
  });

  it("builds a confirm URL without a double slash", () => {
    expect(buildConfirmUrl("https://x.com/", "abc")).toBe(
      "https://x.com/subscribe/confirm/abc",
    );
  });
});

describe("subscribe forms admin API", () => {
  it("creates a form and returns an embed snippet pointing at the public route", async () => {
    const apiKey = await adminKey();
    const listId = await seedList(false);

    const res = await authFetch("/api/subscribe-forms", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ listId, name: "Footer signup" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<any>();
    expect(body.embedSnippet).toContain(`/subscribe/${body.id}`);
    expect(body.embedSnippet).toContain('name="email"');
    // The honeypot must be in the generated markup or the control is dead.
    expect(body.embedSnippet).toContain('name="_hp"');
  });

  it("omits the name input when the form hides it", async () => {
    const apiKey = await adminKey();
    const listId = await seedList(false);
    const created = await (
      await authFetch("/api/subscribe-forms", {
        apiKey,
        method: "POST",
        body: JSON.stringify({ listId, name: "X", showNameField: false }),
      })
    ).json<any>();
    expect(created.embedSnippet).not.toContain('name="name"');
  });

  it("404s when the bound list does not exist", async () => {
    const apiKey = await adminKey();
    const res = await authFetch("/api/subscribe-forms", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ listId: "nope", name: "X" }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses a non-admin", async () => {
    await adminKey();
    const { apiKey } = await createTestUser({
      id: "u-m1",
      role: "member",
      email: "m1@example.com",
    });
    const res = await authFetch("/api/subscribe-forms", { apiKey });
    expect(res.status).toBe(403);
  });
});

describe("confirmation content", () => {
  const opts = {
    listName: "Weekly",
    confirmUrl: "https://x.com/subscribe/confirm/tok",
    templateSlug: null as string | null,
  };

  it("uses the built-in default so double opt-in works with no template set up", async () => {
    const { subject, html } = await buildConfirmationContent(getDb(), opts);
    expect(subject).toBe("Please confirm your subscription");
    expect(html).toContain("https://x.com/subscribe/confirm/tok");
    expect(html).toContain("Weekly");
  });

  it("uses a configured template when one exists", async () => {
    const ts = Math.floor(Date.now() / 1000);
    await getDb().insert(emailTemplates).values({
      id: "t1",
      slug: "confirm-me",
      name: "Confirm",
      subject: "Confirm {{list_name}}",
      bodyHtml: "<p>Go to {{confirm_url}}</p>",
      fromAddress: null,
      createdAt: ts,
      updatedAt: ts,
    });

    const { subject, html } = await buildConfirmationContent(getDb(), {
      ...opts,
      templateSlug: "confirm-me",
    });
    expect(subject).toBe("Confirm Weekly");
    expect(html).toContain("https://x.com/subscribe/confirm/tok");
  });

  /**
   * A slug pointing at a deleted template must not strand the subscriber at
   * `pending` forever — a generic-looking email beats no email.
   */
  it("falls back to the default when the configured template is missing", async () => {
    const { subject } = await buildConfirmationContent(getDb(), {
      ...opts,
      templateSlug: "does-not-exist",
    });
    expect(subject).toBe("Please confirm your subscription");
  });

  it("does not HTML-escape the subject", async () => {
    const ts = Math.floor(Date.now() / 1000);
    await getDb().insert(emailTemplates).values({
      id: "t2",
      slug: "amp",
      name: "Amp",
      subject: "{{list_name}}",
      bodyHtml: "<p>{{list_name}}</p>",
      fromAddress: null,
      createdAt: ts,
      updatedAt: ts,
    });
    const { subject, html } = await buildConfirmationContent(getDb(), {
      ...opts,
      listName: "Tips & Tricks",
      templateSlug: "amp",
    });
    expect(subject).toBe("Tips & Tricks");
    // The body is HTML, so there it must be escaped.
    expect(html).toContain("Tips &amp; Tricks");
  });
});

describe("attempt retention", () => {
  async function seedAttempt(id: string, createdAt: number) {
    await getDb().insert(subscribeAttempts).values({
      id,
      formId: "f",
      emailHash: "h",
      ip: "1.1.1.1",
      attemptType: "submission",
      createdAt,
    });
  }

  it("deletes rows past the retention window and keeps recent ones", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedAttempt("old", now - ATTEMPT_RETENTION_SECONDS - 60);
    await seedAttempt("fresh", now - 60);

    await purgeExpiredAttempts(getDb(), now);

    const remaining = await getDb().select().from(subscribeAttempts);
    expect(remaining.map((r) => r.id)).toEqual(["fresh"]);
  });

  /**
   * Exercises the exact entry point the cron calls. Without this the wiring is
   * unexercised — a missing import there is invisible to `yarn tsc --noEmit`,
   * which only covers `src/`, and would fail at runtime on the hourly tick.
   */
  it("runs from the cron entry point that only takes env", async () => {
    await seedAttempt(
      "stale",
      Math.floor(Date.now() / 1000) - ATTEMPT_RETENTION_SECONDS - 60,
    );
    await runNewsletterMaintenance(env as unknown as CloudflareBindings);
    expect(await getDb().select().from(subscribeAttempts)).toHaveLength(0);
  });
});
