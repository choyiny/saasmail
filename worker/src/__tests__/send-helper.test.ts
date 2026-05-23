import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { suppressions } from "../db/suppressions.schema";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { sendWithSuppressionCheck } from "../lib/send";
import type { SendEmailParams } from "../lib/email-sender";

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

describe("sendWithSuppressionCheck", () => {
  it("blocks send when sole recipient is suppressed", async () => {
    await suppress("alice@example.com");
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: ["alice@example.com"],
      subject: "Hi",
      html: "<p>hi {{unsubscribe_url}}</p>",
    });
    expect(result.delivered).toEqual([]);
    expect(result.suppressed).toEqual(["alice@example.com"]);
    expect(fakeSender.send).not.toHaveBeenCalled();
  });

  it("partitions a mixed recipient list across to and cc", async () => {
    await suppress("bob@example.com");
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: ["alice@example.com", "bob@example.com"],
      cc: ["carol@example.com", "bob@example.com"],
      subject: "Hi",
      html: "<p>hi {{unsubscribe_url}}</p>",
    });
    // Only one delivered `to` (alice) — transport called once.
    expect(result.delivered.sort()).toEqual([
      "alice@example.com",
      "carol@example.com",
    ]);
    // bob appears in both `to` and `cc` → reported twice in `suppressed`.
    expect(result.suppressed.sort()).toEqual([
      "bob@example.com",
      "bob@example.com",
    ]);
    expect(fakeSender.send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe("alice@example.com");
    expect(sent[0].cc).toEqual(["carol@example.com"]);
  });

  it("with transactional=true, bypasses suppression entirely", async () => {
    await suppress("alice@example.com");
    const result = await sendWithSuppressionCheck({
      db: getDb(),
      env: fakeEnv,
      sender: fakeSender,
      from: "test@host",
      to: ["alice@example.com"],
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
      to: ["alice@example.com"],
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
      to: ["alice@example.com"],
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
      to: ["alice@example.com"],
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
      to: ["alice@example.com"],
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
      to: ["alice@example.com"],
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
