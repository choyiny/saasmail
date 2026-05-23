import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { suppressions } from "../db/suppressions.schema";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { sendWithSuppressionCheck } from "../lib/send";
import type { SendEmailParams } from "../lib/email-sender";
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
      cc: ["bob@example.com", "carol@example.com"],
      subject: "Hi",
      html: "<p>hi {{unsubscribe_url}}</p>",
    });
    expect(result.delivered).toEqual(["alice@example.com", "carol@example.com"]);
    expect(result.suppressed).toEqual(["bob@example.com"]);
    expect(fakeSender.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe("alice@example.com");
    expect(sent[0].cc).toEqual(["carol@example.com"]);
  });

  it("promotes first surviving cc when primary `to` is suppressed", async () => {
    await suppress("alice@example.com");
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      cc: ["bob@example.com", "carol@example.com"],
      subject: "Hi",
      html: "<p>hi {{unsubscribe_url}}</p>",
    });
    expect(result.delivered).toEqual(["bob@example.com", "carol@example.com"]);
    expect(result.suppressed).toEqual(["alice@example.com"]);
    expect(fakeSender.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe("bob@example.com");
    expect(sent[0].cc).toEqual(["carol@example.com"]);
  });

  it("unsubscribe token in headers and body matches the transport's `to`", async () => {
    // Regression: when the primary `to` is suppressed and a cc gets promoted,
    // the token must encode the promoted recipient, NOT the original `to`.
    await suppress("alice@example.com");
    await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: "alice@example.com",
      cc: ["bob@example.com", "carol@example.com"],
      subject: "Hi",
      html: "<p>Click {{unsubscribe_url}}</p>",
    });
    const call = sent[0];
    expect(call.to).toBe("bob@example.com");

    const headerToken = extractUnsubToken(call.headers?.["List-Unsubscribe"]);
    const decodedHeader = await verifyToken(
      headerToken,
      fakeEnv.UNSUBSCRIBE_SECRET,
    );
    expect(decodedHeader?.email).toBe("bob@example.com");

    // And the body URL token should match too.
    const bodyMatch = call.html.match(/token=([^"&<>\s]+)/);
    expect(bodyMatch).not.toBeNull();
    const bodyToken = decodeURIComponent(bodyMatch![1]);
    const decodedBody = await verifyToken(
      bodyToken,
      fakeEnv.UNSUBSCRIBE_SECRET,
    );
    expect(decodedBody?.email).toBe("bob@example.com");
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
