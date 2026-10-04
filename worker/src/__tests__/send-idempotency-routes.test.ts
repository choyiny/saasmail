// docs/specs/SPEC-send-idempotency.md §3: the HTTP send routes.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { auditEvents } from "../db/audit-events.schema";
import { sentEmails } from "../db/sent-emails.schema";
import {
  applyMigrations,
  authFetch,
  buildSendForm,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestTemplate,
  createTestUser,
  getDb,
} from "./helpers";

const INBOX = "support@saasmail.test";
const KEY = "5b8f0c1e-6c3d-4b9a-9d2e-7f1a2b3c4d5e";

const compose = (overrides: Record<string, unknown> = {}) => ({
  to: "alice@example.com",
  fromAddress: INBOX,
  subject: "Hello",
  bodyHtml: "<p>hi</p>",
  transactional: true,
  ...overrides,
});

describe("idempotency keys on the send routes", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    (env as any).DEMO_MODE = "1";
  });

  afterEach(() => {
    (env as any).DEMO_MODE = "0";
  });

  function send(
    payload: Record<string, unknown>,
    headers: Record<string, string> = {},
    files: Array<{ name: string; bytes: Uint8Array }> = [],
  ) {
    return authFetch("/api/send", {
      apiKey,
      method: "POST",
      headers,
      body: buildSendForm(payload, files),
    });
  }

  async function counts() {
    const [sent] = await getDb().all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM sent_emails`,
    );
    const sends = (await getDb().select().from(auditEvents)).filter(
      (event) => event.action === "mail.sent",
    );
    return { sent: Number(sent.n), audited: sends.length };
  }

  it("sends once and replays the first answer to a retry", async () => {
    const first = await send(compose(), { "Idempotency-Key": KEY });
    expect(first.status).toBe(201);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    const body = await first.json();

    const retry = await send(compose(), { "Idempotency-Key": KEY });
    expect(retry.status).toBe(201);
    expect(retry.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await retry.json()).toEqual(body);

    // One message, and one audit row: the replay sent nothing.
    expect(await counts()).toEqual({ sent: 1, audited: 1 });
  });

  it("takes the key from the payload, and the header over the payload", async () => {
    const first = await send(compose({ idempotencyKey: KEY }));
    expect(first.status).toBe(201);
    const fromField = await send(compose({ idempotencyKey: KEY }));
    expect(fromField.headers.get("Idempotency-Replayed")).toBe("true");

    // The header names another key: this is a new send.
    const headerWins = await send(compose({ idempotencyKey: KEY }), {
      "Idempotency-Key": "other-key",
    });
    expect(headerWins.headers.get("Idempotency-Replayed")).toBeNull();
    expect((await counts()).sent).toBe(2);
  });

  it("refuses the same key for a different message with 422", async () => {
    await send(compose(), { "Idempotency-Key": KEY });
    const res = await send(compose({ subject: "Something else" }), {
      "Idempotency-Key": KEY,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect((await counts()).sent).toBe(1);
  });

  it("tells a retry of a running send to wait, with 409 and Retry-After", async () => {
    // Another request holds the claim right now.
    const [{ id: userId }] = await getDb().all<{ id: string }>(
      sql`SELECT id FROM users LIMIT 1`,
    );
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { withIdempotency, sendFingerprint } =
      await import("../lib/send-idempotency");
    const running = withIdempotency(
      getDb(),
      {
        userId,
        key: KEY,
        fingerprint: await sendFingerprint({
          kind: "send",
          to: "alice@example.com",
          fromAddress: INBOX,
          cc: undefined,
          subject: "Hello",
          bodyHtml: "<p>hi</p>",
          bodyText: undefined,
          replyTo: undefined,
          transactional: true,
        }),
      },
      async () => {
        await held;
        return { status: 201, body: {} };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await send(compose(), { "Idempotency-Key": KEY });
    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS" });

    release();
    await running;
  });

  it("rejects an invalid key with 400 and stores nothing", async () => {
    const res = await send(compose(), { "Idempotency-Key": "has a space" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
    expect((await counts()).sent).toBe(0);
  });

  it("does not spend the key on a request that fails validation", async () => {
    const invalid = await send(compose({ to: "not-an-address" }), {
      "Idempotency-Key": KEY,
    });
    expect(invalid.status).toBe(400);
    const [row] = await getDb().all(sql`SELECT * FROM send_idempotency`);
    expect(row).toBeUndefined();

    // The corrected request with the same key sends.
    const fixed = await send(compose(), { "Idempotency-Key": KEY });
    expect(fixed.status).toBe(201);
    expect(fixed.headers.get("Idempotency-Replayed")).toBeNull();
  });

  it("tells a retry with different attachment bytes apart", async () => {
    const one = new TextEncoder().encode("first");
    const two = new TextEncoder().encode("second");
    await send(compose(), { "Idempotency-Key": KEY }, [
      { name: "a.txt", bytes: one },
    ]);
    const same = await send(compose(), { "Idempotency-Key": KEY }, [
      { name: "a.txt", bytes: one },
    ]);
    expect(same.headers.get("Idempotency-Replayed")).toBe("true");
    const different = await send(compose(), { "Idempotency-Key": KEY }, [
      { name: "a.txt", bytes: two },
    ]);
    expect(different.status).toBe(422);
  });

  it("works on replies and releases the key after a refused reply", async () => {
    await createTestPerson({ id: "p1", email: "alice@example.com" });
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      messageId: "<e1@example.com>",
    });
    const reply = (payload: Record<string, unknown>) =>
      authFetch("/api/send/reply/e1", {
        apiKey,
        method: "POST",
        headers: { "Idempotency-Key": KEY },
        body: buildSendForm({ fromAddress: INBOX, ...payload }),
      });

    // No body: refused, and the key stays free.
    const refused = await reply({});
    expect(refused.status).toBe(400);
    expect(await getDb().all(sql`SELECT * FROM send_idempotency`)).toEqual([]);

    const first = await reply({ bodyHtml: "<p>thanks</p>" });
    expect(first.status).toBe(201);
    const again = await reply({ bodyHtml: "<p>thanks</p>" });
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(await first.json());
    expect(
      (await getDb().select().from(sentEmails)).filter(
        (row) => row.inReplyTo === "<e1@example.com>",
      ),
    ).toHaveLength(1);
  });

  it("works on template sends, from the header or the JSON body", async () => {
    await createTestTemplate({
      slug: "welcome",
      subject: "Welcome",
      bodyHtml: "<p>Welcome aboard</p>",
    });
    const sendTemplate = (body: Record<string, unknown>, headers = {}) =>
      authFetch("/api/email-templates/welcome/send", {
        apiKey,
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const body = { to: "alice@example.com", fromAddress: INBOX };

    expect((await sendTemplate(body, { "Idempotency-Key": KEY })).status).toBe(
      201,
    );
    const replay = await sendTemplate({ ...body, idempotencyKey: KEY });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    const reused = await sendTemplate(
      { ...body, to: "bob@example.com" },
      { "Idempotency-Key": KEY },
    );
    expect(reused.status).toBe(422);
    expect(await counts()).toEqual({ sent: 1, audited: 1 });
  });

  it("releases the key when the sending inbox is not allowed (403)", async () => {
    const member = await createTestUser({
      id: "member-1",
      email: "member@example.com",
      role: "member",
    });
    const refused = await authFetch("/api/send", {
      apiKey: member.apiKey,
      method: "POST",
      headers: { "Idempotency-Key": KEY },
      body: buildSendForm(compose()),
    });
    expect(refused.status).toBe(403);
    expect(await getDb().all(sql`SELECT * FROM send_idempotency`)).toEqual([]);
  });

  it("does not send again when the first request failed after the provider took the message", async () => {
    const { withIdempotency, sendFingerprint } =
      await import("../lib/send-idempotency");
    const { sendEmail } = await import("../lib/send-email");
    const calls: string[] = [];
    const sender = {
      provider: "demo" as const,
      async send(params: { to: string }) {
        calls.push(params.to);
        return { id: `provider-${calls.length}`, error: null };
      },
      maxAttachmentBytes: () => 25 * 1024 * 1024,
      maxMessageBytes: () => 25 * 1024 * 1024,
    };
    // Recording the sent message fails: the provider already has it.
    const real = getDb();
    const failing = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "insert") {
          return (table: unknown) => {
            if (table === sentEmails) throw new Error("D1 hiccup");
            return target.insert(table as never);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const claim = {
      userId: "test-user-1",
      key: KEY,
      fingerprint: await sendFingerprint({ any: "request" }),
    };
    const attempt = (db: typeof real) =>
      withIdempotency(db, claim, async () => {
        const result = await sendEmail({
          db,
          env: env as unknown as CloudflareBindings,
          payload: compose(),
          files: [],
          allowed: { isAdmin: true },
          sender: sender as never,
        });
        return { status: 201, body: { id: result.id }, sentEmailId: result.id };
      });

    await expect(attempt(failing)).rejects.toThrow("D1 hiccup");
    const retry = await attempt(real);
    expect(calls).toHaveLength(1);
    expect(retry.replayed).toBe(true);
    expect(retry.body).toMatchObject({ status: "sent", incomplete: true });
  });

  it("keeps each person's keys apart", async () => {
    const other = await createTestUser({
      id: "other-user",
      email: "other@example.com",
    });
    await send(compose(), { "Idempotency-Key": KEY });
    const theirs = await authFetch("/api/send", {
      apiKey: other.apiKey,
      method: "POST",
      headers: { "Idempotency-Key": KEY },
      body: buildSendForm(compose({ subject: "Theirs" })),
    });
    expect(theirs.status).toBe(201);
    expect(theirs.headers.get("Idempotency-Replayed")).toBeNull();
  });

  it("documents the header and the conflicts in /doc", async () => {
    const res = await authFetch("/doc", {});
    const doc = (await res.json()) as {
      paths: Record<string, { post?: Record<string, any> }>;
    };
    for (const path of [
      "/api/send",
      "/api/send/reply/{emailId}",
      "/api/email-templates/{slug}/send",
    ]) {
      const post = doc.paths[path]?.post;
      expect(post, path).toBeDefined();
      expect(
        (post!.parameters ?? []).some(
          (p: { name: string; in: string }) =>
            p.in === "header" && p.name.toLowerCase() === "idempotency-key",
        ),
        path,
      ).toBe(true);
      expect(Object.keys(post!.responses), path).toEqual(
        expect.arrayContaining(["409", "422"]),
      );
    }
  });
});
