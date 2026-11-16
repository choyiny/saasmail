import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { suppressions } from "../db/suppressions.schema";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { sendWithSuppressionCheck } from "../lib/send";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import { verifyToken } from "../lib/unsubscribe-token";

const sent: SendEmailParams[] = [];
const fakeSender = {
  provider: "none" as const,
  maxAttachmentBytes: () => 25_000_000,
  send: vi.fn(async (params: SendEmailParams) => {
    sent.push(params);
    return { id: "fake-msg-id", error: null };
  }),
};

const fakeEnv = {
  UNSUBSCRIBE_SECRET: "test-secret-do-not-use-in-prod",
  BASE_URL: "https://mail.example.com",
};

beforeAll(applyMigrations);
beforeEach(async () => {
  await cleanDb();
  sent.length = 0;
  fakeSender.send.mockClear();
});

async function suppress(email: string) {
  const db = getDb();
  await db.insert(suppressions).values({
    id: "test-" + email,
    email: email.toLowerCase(),
    reason: "unsubscribe",
    source: "test",
    note: null,
    createdAt: Math.floor(Date.now() / 1000),
  });
}

function extractUnsubToken(headerValue: string | undefined): string {
  expect(headerValue).toBeDefined();
  const match = headerValue!.match(/token=([^>&]+)/);
  expect(match).not.toBeNull();
  return decodeURIComponent(match![1]);
}

describe("sendWithSuppressionCheck", () => {
  it("blocks send when sole recipient is suppressed", async () => {
    await suppress("alice@example.com");
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      subject: "Hi",
      html: "<p>hi {{unsubscribe_url}}</p>",
    });
    expect(result.delivered).toEqual([]);
    expect(result.suppressed).toEqual(["alice@example.com"]);
    expect(fakeSender.send).not.toHaveBeenCalled();
  });

  it("drops suppressed cc but keeps unsuppressed primary `to`", async () => {
    await suppress("bob@example.com");
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      cc: [{ email: "bob@example.com" }, { email: "carol@example.com" }],
      subject: "Hi",
      html: "<p>hi {{unsubscribe_url}}</p>",
    });
    expect(result.delivered).toEqual([
      "alice@example.com",
      "carol@example.com",
    ]);
    expect(result.suppressed).toEqual(["bob@example.com"]);
    // Marketing path now does one call per delivered recipient.
    expect(fakeSender.send).toHaveBeenCalledTimes(2);
    expect(sent[0].to).toBe("alice@example.com");
    expect(sent[1].to).toBe("carol@example.com");
    // No cc on per-recipient marketing calls.
    expect(sent[0].cc).toBeUndefined();
    expect(sent[1].cc).toBeUndefined();
  });

  it("cancels the entire send when primary `to` is suppressed, even with unsuppressed cc", async () => {
    await suppress("alice@example.com");
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      cc: [{ email: "bob@example.com" }, { email: "carol@example.com" }],
      subject: "Hi",
      html: "<p>hi {{unsubscribe_url}}</p>",
    });
    expect(result.delivered).toEqual([]);
    expect(result.suppressed).toContain("alice@example.com");
    expect(fakeSender.send).not.toHaveBeenCalled();
  });

  it("CC with display name still triggers suppression check", async () => {
    // Regression: pre-formatting CC as "Name <addr>" before the suppression
    // check meant isSuppressed never matched the bare-email column.
    await suppress("bob@example.com");
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      cc: [{ email: "bob@example.com", name: "Bob" }],
      subject: "Hi",
      html: "<p>hi</p>",
    });
    expect(result.suppressed).toContain("bob@example.com");
    expect(result.delivered).toEqual(["alice@example.com"]);
    // Only one transport call, to alice — bob must NOT have been sent.
    expect(fakeSender.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe("alice@example.com");
    const allRecipients = sent.flatMap((s) => [s.to, ...(s.cc ?? [])]);
    expect(allRecipients.some((r) => r.includes("bob@example.com"))).toBe(
      false,
    );
  });

  it("multi-recipient marketing send: each recipient gets a per-recipient token", async () => {
    await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      cc: [{ email: "bob@example.com" }, { email: "carol@example.com" }],
      subject: "Hi",
      html: "<p>Click {{unsubscribe_url}}</p>",
    });

    expect(fakeSender.send).toHaveBeenCalledTimes(3);
    const recipients = sent.map((s) => s.to);
    expect(recipients).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);

    // Each call has no cc — every recipient sees themselves as the sole to.
    for (const call of sent) {
      expect(call.cc).toBeUndefined();
    }

    // Each call's List-Unsubscribe header token decodes back to that call's `to`.
    for (const call of sent) {
      const headerToken = extractUnsubToken(call.headers?.["List-Unsubscribe"]);
      const decoded = await verifyToken(
        headerToken,
        fakeEnv.UNSUBSCRIBE_SECRET,
      );
      expect(decoded?.email).toBe(call.to);
    }
  });

  it("multi-recipient transactional send: single call with cc preserved", async () => {
    await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      cc: [
        { email: "bob@example.com" },
        { email: "carol@example.com", name: "Carol" },
      ],
      subject: "Reset",
      html: "<p>token</p>",
      transactional: true,
    });
    expect(fakeSender.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe("alice@example.com");
    // cc preserved as formatted strings; display name on carol becomes "Carol <…>".
    expect(sent[0].cc).toEqual([
      "bob@example.com",
      "Carol <carol@example.com>",
    ]);
    expect(sent[0].headers?.["List-Unsubscribe"]).toBeUndefined();
  });

  it("with transactional=true, bypasses suppression entirely", async () => {
    await suppress("alice@example.com");
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      subject: "Reset",
      html: "<p>token</p>",
      transactional: true,
    });
    expect(result.delivered).toEqual(["alice@example.com"]);
    expect(result.suppressed).toEqual([]);
    expect(fakeSender.send).toHaveBeenCalledTimes(1);
  });

  it("marketing send: adds List-Unsubscribe headers and interpolates {{unsubscribe_url}}", async () => {
    await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      subject: "Hi",
      html: "<p>Click {{unsubscribe_url}}</p>",
    });
    const call = sent[0];
    expect(call.headers?.["List-Unsubscribe"]).toMatch(
      /^<https:\/\/mail\.example\.com\/unsubscribe\?token=[^>]+>$/,
    );
    expect(call.headers?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    expect(call.html).toMatch(
      /Click https:\/\/mail\.example\.com\/unsubscribe\?token=/,
    );
    expect(call.html).not.toContain("{{unsubscribe_url}}");
    expect(call.headers?.["List-Unsubscribe"]).not.toContain("mailto:");
  });

  it("transactional send: no unsubscribe headers, no footer, no variable", async () => {
    await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      subject: "Reset",
      html: "<p>Click here</p>",
      text: "Click here",
      transactional: true,
    });
    const call = sent[0];
    expect(call.headers?.["List-Unsubscribe"]).toBeUndefined();
    expect(call.headers?.["List-Unsubscribe-Post"]).toBeUndefined();
    expect(call.html).toBe("<p>Click here</p>");
    expect(call.text).toBe("Click here");
  });

  it("auto-appends HTML footer when body lacks the URL", async () => {
    await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      subject: "Hi",
      html: "<p>No link here</p>",
    });
    const call = sent[0];
    expect(call.html).toContain("No link here");
    expect(call.html).toMatch(
      /<a href="https:\/\/mail\.example\.com\/unsubscribe\?token=[^"]+">Unsubscribe<\/a>/,
    );
  });

  it("does NOT auto-append HTML footer when body already includes the URL", async () => {
    await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      subject: "Hi",
      html: "<p>Link: {{unsubscribe_url}}</p>",
    });
    const call = sent[0];
    expect(call.html.match(/\/unsubscribe\?token=/g)?.length).toBe(1);
  });

  it("auto-appends plaintext footer when text body lacks URL", async () => {
    await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      subject: "Hi",
      html: "<p>hi</p>",
      text: "Hello no link",
    });
    const call = sent[0];
    expect(call.text).toContain("Hello no link");
    expect(call.text).toMatch(
      /Unsubscribe: https:\/\/mail\.example\.com\/unsubscribe\?token=/,
    );
  });
});

describe("sendWithSuppressionCheck: recipients the provider refuses", () => {
  /**
   * A Postmark-like sender that refuses `dead` addresses as permanently
   * undeliverable and accepts everyone else.
   */
  function refusingSender(dead: string[]): EmailSender & {
    send: ReturnType<typeof vi.fn>;
  } {
    return {
      provider: "postmark" as const,
      maxAttachmentBytes: () => 25_000_000,
      send: vi.fn(async (params: SendEmailParams): Promise<SendEmailResult> => {
        const recipients = [params.to, ...(params.cc ?? [])].map((r) =>
          (/<([^>]+)>/.exec(r)?.[1] ?? r).toLowerCase(),
        );
        const refused = recipients.filter((r) => dead.includes(r));
        if (refused.length === 0) return { id: "pm-ok", error: null };
        return {
          id: null,
          error: {
            message: `Found inactive addresses: ${refused.join(", ")}.`,
            transient: false,
            undeliverable: refused,
          },
        };
      }),
    };
  }

  async function suppressionRows() {
    return getDb().select().from(suppressions);
  }

  it("transactional: every recipient refused reports suppressed and records them", async () => {
    const sender = refusingSender(["dead@example.com"]);
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender,
      from: "test@host",
      to: "Dead@Example.com",
      subject: "Your code",
      html: "<p>123456</p>",
      transactional: true,
    });
    expect(result.delivered).toEqual([]);
    expect(result.suppressed).toEqual(["Dead@Example.com"]);
    expect(result.result?.error?.undeliverable).toEqual(["dead@example.com"]);

    const rows = await suppressionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "dead@example.com",
      reason: "provider",
      source: "postmark",
    });
  });

  it("transactional: a partial refusal stays a failure but records the dead address", async () => {
    const sender = refusingSender(["dead@example.com"]);
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender,
      from: "test@host",
      to: "alive@example.com",
      cc: [{ email: "dead@example.com" }],
      subject: "Hi",
      html: "<p>hi</p>",
      transactional: true,
    });
    expect(result.delivered).toEqual(["alive@example.com", "dead@example.com"]);
    expect(result.result?.error?.transient).toBe(false);
    const rows = await suppressionRows();
    expect(rows.map((r) => r.email)).toEqual(["dead@example.com"]);
  });

  it("marketing: a refused cc moves to suppressed while the rest are delivered", async () => {
    const sender = refusingSender(["dead@example.com"]);
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender,
      from: "test@host",
      to: "alive@example.com",
      cc: [{ email: "dead@example.com" }],
      subject: "News",
      html: "<p>news {{unsubscribe_url}}</p>",
    });
    expect(result.delivered).toEqual(["alive@example.com"]);
    expect(result.suppressed).toEqual(["dead@example.com"]);
    expect(result.result).toEqual({ id: "pm-ok", error: null });
  });

  it("marketing: a refused primary leaves the surviving cc as the reported result", async () => {
    const sender = refusingSender(["dead@example.com"]);
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender,
      from: "test@host",
      to: "dead@example.com",
      cc: [{ email: "alive@example.com" }],
      subject: "News",
      html: "<p>news</p>",
    });
    expect(result.delivered).toEqual(["alive@example.com"]);
    expect(result.suppressed).toEqual(["dead@example.com"]);
    expect(result.result?.error).toBeNull();
  });

  it("the next marketing send skips a provider-refused address without calling the provider", async () => {
    const sender = refusingSender(["dead@example.com"]);
    const params = {
      db: getDb(),
      env: fakeEnv,
      sender,
      from: "test@host",
      to: "dead@example.com",
      subject: "News",
      html: "<p>news</p>",
    };
    await sendWithSuppressionCheck(params);
    expect(sender.send).toHaveBeenCalledTimes(1);

    const second = await sendWithSuppressionCheck(params);
    expect(second.suppressed).toEqual(["dead@example.com"]);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing suppression's reason when the provider refuses the address again", async () => {
    await suppress("dead@example.com");
    const sender = refusingSender(["dead@example.com"]);
    await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender,
      from: "test@host",
      to: "dead@example.com",
      subject: "Reset",
      html: "<p>reset</p>",
      transactional: true,
    });
    const rows = await suppressionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("unsubscribe");
  });
});
