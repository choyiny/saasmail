import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestTemplate,
  authFetch,
  getDb,
} from "./helpers";
import { suppressions } from "../db/suppressions.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { MAX_VARIABLE_DEPTH } from "../lib/template-variables-schema";

/** Builds a value nested `n` array-levels deep, terminating in a string leaf. */
function buildNestedArray(n: number): unknown {
  return n <= 0 ? "leaf" : [buildNestedArray(n - 1)];
}

describe("email templates router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("POST /api/email-templates", () => {
    it("creates a template", async () => {
      const res = await authFetch("/api/email-templates", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          slug: "welcome-email",
          name: "Welcome",
          subject: "Welcome {{name}}",
          bodyHtml: "<p>Hi {{name}}</p>",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.slug).toBe("welcome-email");
      expect(data.name).toBe("Welcome");
    });

    it("rejects invalid slug format", async () => {
      const res = await authFetch("/api/email-templates", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          slug: "Invalid Slug!",
          name: "Test",
          subject: "Test",
          bodyHtml: "<p>Test</p>",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a template whose sections do not parse", async () => {
      // Storing this would defer the failure to send time, where every send
      // 400s and every sequence step is marked `failed` — a terminal state
      // the poller never revisits, with no signal to the author.
      const res = await authFetch("/api/email-templates", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          slug: "broken",
          name: "Broken",
          subject: "Hi",
          bodyHtml: "{{#items}}<li>{{label}}</li>",
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Unclosed section");
    });

    it("rejects a template with an unknown filter", async () => {
      const res = await authFetch("/api/email-templates", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          slug: "bad-filter",
          name: "Bad filter",
          subject: "Hi",
          bodyHtml: "<p>{{name|upper}}</p>",
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Unknown filter");
    });
  });

  describe("GET /api/email-templates", () => {
    it("lists all templates", async () => {
      await createTestTemplate({ slug: "welcome" });
      await createTestTemplate({ slug: "follow-up", name: "Follow Up" });

      const res = await authFetch("/api/email-templates", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(2);
    });
  });

  describe("GET /api/email-templates/:slug", () => {
    it("returns template by slug", async () => {
      await createTestTemplate({ slug: "welcome" });

      const res = await authFetch("/api/email-templates/welcome", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slug).toBe("welcome");
    });

    it("returns 404 for missing template", async () => {
      const res = await authFetch("/api/email-templates/nonexistent", {
        apiKey,
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/email-templates/:slug/variables", () => {
    it("returns the required variables", async () => {
      await createTestTemplate({
        slug: "welcome",
        subject: "Hello {{name}}",
        bodyHtml: "<p>Hi {{name}}, from {{company}}</p>",
      });

      const res = await authFetch("/api/email-templates/welcome/variables", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(new Set(data.variables)).toEqual(new Set(["name", "company"]));
    });

    it("returns 400, not 500, for a template with an unbalanced section", async () => {
      await createTestTemplate({
        slug: "broken",
        subject: "Hello",
        bodyHtml: "{{#a}}oops",
      });

      const res = await authFetch("/api/email-templates/broken/variables", {
        apiKey,
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeTruthy();
    });
  });

  describe("PUT /api/email-templates/:slug", () => {
    it("updates template fields", async () => {
      await createTestTemplate({ slug: "welcome" });

      const res = await authFetch("/api/email-templates/welcome", {
        apiKey,
        method: "PUT",
        body: JSON.stringify({
          name: "Welcome Updated",
          subject: "Updated Subject",
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("Welcome Updated");
      expect(data.subject).toBe("Updated Subject");
    });

    it("returns 404 for missing template", async () => {
      const res = await authFetch("/api/email-templates/nonexistent", {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ name: "Test" }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects an update that leaves the template unparseable", async () => {
      await createTestTemplate({ slug: "welcome" });

      const res = await authFetch("/api/email-templates/welcome", {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ bodyHtml: "{{#items}}<li>{{label}}</li>" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Unclosed section");
    });

    it("validates the merged template, not just the fields being changed", async () => {
      // Both fields are optional on this route. A body that opens a section
      // closed by the subject only parses as a pair, so validating the
      // incoming field alone would reject a template that is in fact fine —
      // and, in the reverse direction, accept one that is not.
      await createTestTemplate({
        slug: "paired",
        subject: "Hi",
        bodyHtml: "<p>plain</p>",
      });

      // Changing only the subject must still be checked against the stored body.
      const bad = await authFetch("/api/email-templates/paired", {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ subject: "{{/nope}}" }),
      });
      expect(bad.status).toBe(400);

      // And a well-formed pair still goes through.
      const good = await authFetch("/api/email-templates/paired", {
        apiKey,
        method: "PUT",
        body: JSON.stringify({
          bodyHtml: "{{#items}}<li>{{label}}</li>{{/items}}",
        }),
      });
      expect(good.status).toBe(200);
    });
  });

  describe("DELETE /api/email-templates/:slug", () => {
    it("deletes a template", async () => {
      await createTestTemplate({ slug: "welcome" });

      const res = await authFetch("/api/email-templates/welcome", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      const getRes = await authFetch("/api/email-templates/welcome", {
        apiKey,
      });
      expect(getRes.status).toBe(404);
    });

    it("returns 404 for missing template", async () => {
      const res = await authFetch("/api/email-templates/nonexistent", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/email-templates/:slug/send", () => {
    it("returns status=suppressed and does not write sent_emails when recipient is suppressed", async () => {
      const db = getDb();
      await createTestTemplate({
        slug: "welcome",
        subject: "Hi",
        bodyHtml: "<p>Hi {{name}}</p>",
      });

      const now = Math.floor(Date.now() / 1000);
      await db.insert(suppressions).values({
        id: "sup-1",
        email: "blocked@test.com",
        reason: "unsubscribe",
        source: "test",
        note: null,
        createdAt: now,
      });

      const res = await authFetch("/api/email-templates/welcome/send", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          to: "blocked@test.com",
          fromAddress: "support@example.com",
          variables: { name: "Blocked" },
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.status).toBe("suppressed");
      expect(data.id).toBeNull();
      expect(data.resendId).toBeNull();
      expect(data.delivered).toEqual([]);
      expect(data.suppressed).toEqual(["blocked@test.com"]);

      // No sent_emails row should have been written for the suppressed send
      const sentRows = await db.select().from(sentEmails);
      expect(sentRows).toHaveLength(0);
    });

    it("returns TEMPLATE_PARSE_ERROR with the parse diagnostic for an unbalanced section", async () => {
      await createTestTemplate({
        slug: "broken",
        subject: "Hi",
        bodyHtml: "{{#a}}oops",
      });

      const res = await authFetch("/api/email-templates/broken/send", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          to: "person@example.com",
          fromAddress: "support@example.com",
          variables: {},
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/\{\{#a\}\}/);
      expect(data.missingVariables).toBeUndefined();
      expect(data.requiredVariables).toBeUndefined();
    });
  });

  describe("templates: sections and nested variables", () => {
    beforeEach(() => {
      // DemoSender always succeeds, so the send path runs end-to-end and
      // actually stores the rendered body instead of failing on the fake
      // RESEND_API_KEY the global test env sets. See send-router.test.ts for
      // the same pattern.
      (env as any).DEMO_MODE = "1";
    });

    afterEach(() => {
      (env as any).DEMO_MODE = "0";
    });

    it("accepts an array of objects in the send payload and renders each item", async () => {
      await createTestTemplate({
        slug: "digest",
        subject: "Your digest",
        bodyHtml: "{{#items}}<li>{{label}}</li>{{/items}}",
      });

      const res = await authFetch("/api/email-templates/digest/send", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          to: "a@example.com",
          fromAddress: "support@example.com",
          variables: { items: [{ label: "one" }, { label: "two" }] },
        }),
      });

      expect(res.status).toBe(201);

      const rows = await getDb().select().from(sentEmails);
      expect(rows).toHaveLength(1);
      expect(rows[0].bodyHtml).toContain("<li>one</li>");
      expect(rows[0].bodyHtml).toContain("<li>two</li>");
    });

    it("reports optional and section variables from /variables", async () => {
      await createTestTemplate({
        slug: "digest2",
        subject: "Hi {{name}}",
        bodyHtml: "{{promo?}}{{#items}}{{label}}{{/items}}",
      });

      const res = await authFetch("/api/email-templates/digest2/variables", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.variables).toEqual(["name", "items"]);
      expect(body.optional).toEqual(["promo"]);
      expect(body.sections).toEqual([
        { name: "items", inverted: false, variables: ["label"] },
      ]);
    });

    it("rejects a variables payload nested past MAX_VARIABLE_DEPTH with 400, not 500", async () => {
      await createTestTemplate({
        slug: "deep",
        subject: "S",
        bodyHtml: "<p>B</p>",
      });

      const res = await authFetch("/api/email-templates/deep/send", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          to: "a@example.com",
          fromAddress: "support@example.com",
          // One level past the cap — buildNestedArray(MAX_VARIABLE_DEPTH)
          // puts its deepest leaf at depth MAX_VARIABLE_DEPTH + 1.
          variables: { items: buildNestedArray(MAX_VARIABLE_DEPTH) },
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      // The Zod validation error surfaces as { error: { message: "<json array>" } };
      // assert the underlying custom-issue message, not its exact envelope shape.
      expect(data.error.message).toContain(String(MAX_VARIABLE_DEPTH));
      expect(data.error.message).toMatch(/nested too deeply/i);
    });

    it("accepts a variables payload nested right at MAX_VARIABLE_DEPTH", async () => {
      await createTestTemplate({
        slug: "deep-ok",
        subject: "S",
        bodyHtml: "<p>B</p>",
      });

      const res = await authFetch("/api/email-templates/deep-ok/send", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          to: "a@example.com",
          fromAddress: "support@example.com",
          // Deepest leaf lands exactly at MAX_VARIABLE_DEPTH — within bounds.
          variables: { items: buildNestedArray(MAX_VARIABLE_DEPTH - 1) },
        }),
      });

      expect(res.status).toBe(201);
    });
  });

  describe("send-test outbox integration", () => {
    it("keeps a failed outbox row when no provider is configured", async () => {
      (env as any).DEMO_MODE = "0";
      const savedKey = (env as any).RESEND_API_KEY;
      const savedEmail = (env as any).EMAIL;
      (env as any).RESEND_API_KEY = undefined;
      (env as any).EMAIL = undefined;
      try {
        await createTestTemplate({
          slug: "plain",
          subject: "S",
          bodyHtml: "<p>B</p>",
        });
        const res = await authFetch("/api/email-templates/plain/send", {
          apiKey,
          method: "POST",
          body: JSON.stringify({
            to: "nobody@example.com",
            fromAddress: "me@saasmail.test",
            variables: {},
          }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe("failed");
        const outbox = await getDb().select().from(outboxEmails);
        expect(outbox).toHaveLength(1);
        expect(outbox[0].status).toBe("failed");
      } finally {
        (env as any).RESEND_API_KEY = savedKey;
        (env as any).EMAIL = savedEmail;
      }
    });
  });
});
