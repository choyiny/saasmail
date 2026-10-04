// docs/archive/SPEC-spam-learning.md: a spam filter that learns from the
// team's marks.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { spamModels, spamTraining } from "../db/spam-filter.schema";
import { handleEmail } from "../email-handler";
import { runWithAudit, systemActor } from "../lib/audit/context";
import { ruleActor, userActor } from "../lib/audit/actors";
import { matchCondition } from "../lib/rules/match";
import { deleteMessageState, setMailboxState } from "../lib/messages/state";
import { score } from "../lib/spam/score";
import { tokenize } from "../lib/spam/tokenize";
import {
  pruneSpamTokens,
  readSpamModel,
  setSpamFilterEnabled,
  trainMessage,
} from "../lib/spam/filter";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const INBOX = "support@saasmail.test";
const admin = { isAdmin: true as const };

async function tokenCount(token: string) {
  const [row] = await getDb().all<{ spam_count: number; ham_count: number }>(
    sql`SELECT spam_count, ham_count FROM spam_tokens WHERE inbox = ${INBOX} AND token = ${token}`,
  );
  return row
    ? { spam: Number(row.spam_count), ham: Number(row.ham_count) }
    : null;
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

describe("tokenize", () => {
  it("prefixes sender, subject and attachment tokens, and keeps money", () => {
    expect(
      tokenize({
        fromAddress: "Bob@Spam.Example",
        subject: "WIN $500 today!",
        bodyText:
          "Claim your prize: 2024 is the year. Gewinnen Sie jetzt.\n\nOn Mon, X wrote:\n> quoted secret",
        bodyHtml: null,
        hasAttachments: true,
      }),
    ).toEqual([
      "f:bob@spam.example",
      "d:spam.example",
      "h:attachments",
      "s:win",
      "s:$500",
      "s:today",
      "claim",
      "your",
      "prize",
      "the",
      "year",
      "gewinnen",
      "sie",
      "jetzt",
    ]);
  });

  it("stops at 150 distinct tokens, and reads HTML when there is no text", () => {
    const many = Array.from({ length: 400 }, (_, i) => `word${i}x`).join(" ");
    expect(
      tokenize({
        fromAddress: null,
        subject: null,
        bodyText: many,
        bodyHtml: null,
        hasAttachments: false,
      }),
    ).toHaveLength(150);
    expect(
      tokenize({
        fromAddress: null,
        subject: null,
        bodyText: "",
        bodyHtml: "<p>Cheap <b>pills</b></p>",
        hasAttachments: false,
      }),
    ).toEqual(["cheap", "pills"]);
  });
});

describe("score", () => {
  const model = { spamMessages: 20, hamMessages: 20 };

  it("smooths each token by how often it was seen, and combines the telling ones", () => {
    const counts = new Map([
      ["a", { spamCount: 10, hamCount: 0 }], // (0.5 + 10·1) / 11
      ["b", { spamCount: 10, hamCount: 5 }], // 0.5: says nothing
      ["c", { spamCount: 0, hamCount: 10 }], // (0.5 + 10·0) / 11
      ["d", { spamCount: 20, hamCount: 0 }], // (0.5 + 20) / 21
      ["e", { spamCount: 15, hamCount: 0 }], // (0.5 + 15) / 16
    ]);
    const telling = [10.5 / 11, 0.5 / 11, 20.5 / 21, 15.5 / 16];
    const spam = telling.reduce((product, p) => product * p, 1);
    const ham = telling.reduce((product, p) => product * (1 - p), 1);
    expect(
      score(["a", "b", "c", "d", "e", "unknown"], counts, model),
    ).toBeCloseTo(spam / (spam + ham), 10);
  });

  it("keeps a token seen once close to neutral", () => {
    const once = new Map(
      ["a", "b", "c", "d", "e"].map((token) => [
        token,
        { spamCount: 1, hamCount: 0 },
      ]),
    );
    // Each is (0.5 + 1) / 2 = 0.75, not 0.99: five of them are not proof.
    expect(score(["a", "b", "c", "d", "e"], once, model)).toBeLessThan(0.999);
    expect(score(["a", "b", "c", "d", "e"], once, model)).toBeCloseTo(
      0.75 ** 5 / (0.75 ** 5 + 0.25 ** 5),
      10,
    );
  });

  it("needs five known tokens", () => {
    const counts = new Map([["a", { spamCount: 10, hamCount: 0 }]]);
    expect(score(["a", "b", "c"], counts, model)).toBeNull();
  });

  it("keeps the 15 farthest from 0.5", () => {
    const counts = new Map<string, { spamCount: number; hamCount: number }>();
    const tokens: string[] = [];
    for (let i = 0; i < 16; i++) {
      counts.set(`spam${i}`, { spamCount: 20, hamCount: 0 });
      tokens.push(`spam${i}`);
    }
    // Twenty middling not-junk tokens do not outvote them: only 15 count.
    for (let i = 0; i < 20; i++) {
      counts.set(`mid${i}`, { spamCount: 4, hamCount: 4 });
      tokens.push(`mid${i}`);
    }
    expect(score(tokens, counts, model)).toBeGreaterThan(0.999);
  });
});

describe("training", () => {
  beforeEach(async () => {
    await createTestUser({ id: "u1", email: "jane@acme.com" });
    await createTestPerson({ id: "p1", email: "bob@spam.example" });
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      subject: "Cheap pills",
      bodyText: "buy cheap pills now",
    });
    await setSpamFilterEnabled(getDb(), INBOX, true);
  });

  const message = {
    fromAddress: "bob@spam.example",
    subject: "Cheap pills",
    bodyText: "buy cheap pills now",
    bodyHtml: null,
    hasAttachments: false,
  };

  it("counts a message once per label, and moves it when the label changes", async () => {
    const train = (label: "spam" | "ham") =>
      trainMessage(getDb(), {
        inbox: INBOX,
        emailId: "e1",
        label,
        userId: "u1",
        message,
      });

    expect(await train("spam")).toBe(true);
    expect(await train("spam")).toBe(false);
    expect(await tokenCount("cheap")).toEqual({ spam: 1, ham: 0 });
    expect(await readSpamModel(getDb(), INBOX)).toMatchObject({
      spamMessages: 1,
      hamMessages: 0,
    });

    expect(await train("ham")).toBe(true);
    expect(await tokenCount("cheap")).toEqual({ spam: 0, ham: 1 });
    expect(await readSpamModel(getDb(), INBOX)).toMatchObject({
      spamMessages: 0,
      hamMessages: 1,
    });
  });

  it("trains a 150-token message in one statement per label", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `token${i}x`).join(" ");
    await trainMessage(getDb(), {
      inbox: INBOX,
      emailId: "e1",
      label: "spam",
      userId: "u1",
      message: { ...message, subject: null, fromAddress: null, bodyText: many },
    });
    const [row] = await getDb().all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM spam_tokens WHERE inbox = ${INBOX}`,
    );
    expect(Number(row.n)).toBe(150);
  });

  it("learns from a person's junk mark, and not-junk only for mail that was junk", async () => {
    const asPerson = <T>(fn: () => Promise<T>) =>
      runWithAudit(userActor({ id: "u1", email: "jane@acme.com" }), fn);
    const ref = [{ kind: "received" as const, id: "e1" }];

    // Not junk, on mail that never was: nothing to learn.
    await asPerson(() =>
      setMailboxState(getDb(), admin, "u1", ref, { spam: false }),
    );
    expect(await tokenCount("cheap")).toBeNull();

    await asPerson(() =>
      setMailboxState(getDb(), admin, "u1", ref, { spam: true }),
    );
    expect(await tokenCount("cheap")).toEqual({ spam: 1, ham: 0 });

    await asPerson(() =>
      setMailboxState(getDb(), admin, "u1", ref, { spam: false }),
    );
    expect(await tokenCount("cheap")).toEqual({ spam: 0, ham: 1 });
  });

  it("never learns from the agent, which a message could talk into it", async () => {
    const { agentActor } = await import("../lib/audit/actors");
    await runWithAudit(
      agentActor({ id: "u1", email: "jane@acme.com" }, "session-1"),
      () =>
        setMailboxState(
          getDb(),
          admin,
          "u1",
          [{ kind: "received", id: "e1" }],
          { spam: true },
        ),
    );
    expect(await tokenCount("cheap")).toBeNull();
  });

  it("counts two identical marks at the same time once", async () => {
    const train = () =>
      trainMessage(getDb(), {
        inbox: INBOX,
        emailId: "e1",
        label: "spam",
        userId: "u1",
        message,
      });
    const results = await Promise.all([train(), train(), train()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await tokenCount("cheap")).toEqual({ spam: 1, ham: 0 });
    expect(await readSpamModel(getDb(), INBOX)).toMatchObject({
      spamMessages: 1,
    });
  });

  it("does not let a reply undo a junk mark", async () => {
    await trainMessage(getDb(), {
      inbox: INBOX,
      emailId: "e1",
      label: "spam",
      userId: "u1",
      message,
    });
    expect(
      await trainMessage(getDb(), {
        inbox: INBOX,
        emailId: "e1",
        label: "ham",
        userId: "u1",
        message,
        onlyIfUntrained: true,
      }),
    ).toBe(false);
    expect(await tokenCount("cheap")).toEqual({ spam: 1, ham: 0 });
  });

  it("trains at most 50 messages per mark", async () => {
    for (let i = 0; i < 55; i++) {
      await createTestEmail({
        id: `bulk-${i}`,
        personId: "p1",
        recipient: INBOX,
        messageId: `<bulk-${i}@example.com>`,
        subject: "Cheap pills",
        bodyText: "buy cheap pills now",
      });
    }
    await runWithAudit(userActor({ id: "u1", email: "jane@acme.com" }), () =>
      setMailboxState(
        getDb(),
        admin,
        "u1",
        Array.from({ length: 55 }, (_, i) => ({
          kind: "received" as const,
          id: `bulk-${i}`,
        })),
        { spam: true },
      ),
    );
    expect(await readSpamModel(getDb(), INBOX)).toMatchObject({
      spamMessages: 50,
    });
  });

  it("never learns from a rule, the system or an import", async () => {
    const ref = [{ kind: "received" as const, id: "e1" }];
    await runWithAudit(ruleActor({ id: "r1", name: "Junk" }), () =>
      setMailboxState(getDb(), admin, null, ref, { spam: true }),
    );
    await runWithAudit(systemActor("inbound"), () =>
      setMailboxState(getDb(), admin, null, ref, { spam: true }),
    );
    await runWithAudit(
      { ...systemActor("import"), actorType: "user", actorUserId: "u1" },
      () => setMailboxState(getDb(), admin, "u1", ref, { spam: true }),
    );
    expect(await tokenCount("cheap")).toBeNull();
  });

  it("does not learn while the inbox's filter is off", async () => {
    await setSpamFilterEnabled(getDb(), INBOX, false);
    await runWithAudit(userActor({ id: "u1", email: "jane@acme.com" }), () =>
      setMailboxState(getDb(), admin, "u1", [{ kind: "received", id: "e1" }], {
        spam: true,
      }),
    );
    expect(await tokenCount("cheap")).toBeNull();
  });

  it("forgets a deleted message's training row", async () => {
    await runWithAudit(userActor({ id: "u1", email: "jane@acme.com" }), () =>
      setMailboxState(getDb(), admin, "u1", [{ kind: "received", id: "e1" }], {
        spam: true,
      }),
    );
    expect(await getDb().select().from(spamTraining)).toHaveLength(1);
    await deleteMessageState(getDb(), [{ kind: "received", id: "e1" }]);
    expect(await getDb().select().from(spamTraining)).toHaveLength(0);
  });

  it("learns not-junk from a person's reply", async () => {
    const { apiKey } = await createTestUser({
      id: "u2",
      email: "admin2@acme.com",
    });
    await getDb()
      .insert(senderIdentities)
      .values({ email: INBOX, createdAt: 1, updatedAt: 1 });
    (env as any).DEMO_MODE = "1";
    try {
      const res = await authFetch("/api/send/reply/e1", {
        apiKey,
        method: "POST",
        body: (() => {
          const form = new FormData();
          form.append(
            "payload",
            JSON.stringify({ fromAddress: INBOX, bodyHtml: "<p>ok</p>" }),
          );
          return form;
        })(),
      });
      expect(res.status).toBe(201);
    } finally {
      (env as any).DEMO_MODE = "0";
    }
    expect(await tokenCount("cheap")).toEqual({ spam: 0, ham: 1 });
  });
});

describe("scoring new mail", () => {
  function inbound(messageId: string, subject: string, body: string) {
    const raw = new TextEncoder().encode(
      [
        "From: Bob <bob@spam.example>",
        `To: ${INBOX}`,
        `Subject: ${subject}`,
        `Message-ID: <${messageId}>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
      ].join("\r\n"),
    );
    return {
      from: "bob@spam.example",
      to: INBOX,
      raw: new Response(raw).body!,
      rawSize: raw.byteLength,
      headers: new Headers(),
      setReject() {},
      async forward() {},
      async reply() {},
    } as unknown as ForwardableEmailMessage;
  }

  async function deliver(messageId: string, subject: string, body: string) {
    const pending: Promise<unknown>[] = [];
    await handleEmail(
      inbound(messageId, subject, body),
      env as never,
      {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    await Promise.allSettled(pending);
    const [row] = await getDb()
      .select({ spamProbability: emails.spamProbability })
      .from(emails)
      .where(eq(emails.messageId, `<${messageId}>`));
    return row?.spamProbability ?? null;
  }

  async function trainMany(count: number) {
    for (let i = 0; i < count; i++) {
      await trainMessage(getDb(), {
        inbox: INBOX,
        emailId: `junk-${i}`,
        label: "spam",
        userId: "u1",
        message: {
          fromAddress: "bob@spam.example",
          subject: "Cheap pills",
          bodyText: "buy cheap pills discount pharmacy offer now",
          bodyHtml: null,
          hasAttachments: false,
        },
      });
      await trainMessage(getDb(), {
        inbox: INBOX,
        emailId: `ham-${i}`,
        label: "ham",
        userId: "u1",
        message: {
          fromAddress: "alice@customer.example",
          subject: "Invoice question",
          bodyText: "could you resend the invoice for our account please",
          bodyHtml: null,
          hasAttachments: false,
        },
      });
    }
  }

  it("does not score before 20 junk and 20 not-junk messages", async () => {
    await setSpamFilterEnabled(getDb(), INBOX, true);
    await trainMany(19);
    expect(
      await deliver("s1@spam.example", "Cheap pills", "buy cheap pills now"),
    ).toBeNull();
  });

  it("scores once trained, and a rule condition can act on it", async () => {
    await setSpamFilterEnabled(getDb(), INBOX, true);
    await trainMany(20);
    const probability = await deliver(
      "s2@spam.example",
      "Cheap pills",
      "buy cheap pills discount pharmacy offer now",
    );
    expect(probability).toBeGreaterThan(0.9);
    const condition = {
      field: "spam_probability" as const,
      operator: "gte" as const,
      value: 0.9,
    };
    const message = {
      fromAddress: "x@y.z",
      subject: null,
      bodyText: null,
      bodyHtml: null,
      hasAttachments: false,
      spamScore: null,
      headers: {},
    };
    expect(
      matchCondition(condition, { ...message, spamProbability: probability }),
    ).toBe(true);
    expect(
      matchCondition(condition, { ...message, spamProbability: null }),
    ).toBe(false);
  });

  it("does not score while the filter is off", async () => {
    await trainMany(20);
    expect(
      await deliver("s3@spam.example", "Cheap pills", "buy cheap pills now"),
    ).toBeNull();
  });
});

describe("pruning", () => {
  it("keeps the cap, dropping the rarest and oldest tokens first", async () => {
    // Only inboxes trained on enough mail to reach the cap are counted.
    await getDb().run(sql`
      INSERT INTO spam_models (inbox, enabled, spam_messages, ham_messages, updated_at)
      VALUES (${INBOX}, 1, 1, 0, 1)
    `);
    await getDb().run(sql`
      INSERT INTO spam_tokens (inbox, token, spam_count, ham_count, updated_at) VALUES
        (${INBOX}, 'rare-old', 1, 0, 1),
        (${INBOX}, 'rare-new', 1, 0, 5),
        (${INBOX}, 'common-old', 9, 3, 1),
        (${INBOX}, 'common-new', 9, 3, 5)
    `);
    expect(await pruneSpamTokens(getDb(), 2)).toBe(2);
    const left = await getDb().all<{ token: string }>(
      sql`SELECT token FROM spam_tokens ORDER BY token`,
    );
    expect(left.map((row) => row.token)).toEqual(["common-new", "common-old"]);
  });
});

describe("the admin routes", () => {
  it("report, switch on and reset an inbox's filter", async () => {
    const { apiKey } = await createTestUser();
    await getDb()
      .insert(senderIdentities)
      .values({ email: INBOX, createdAt: 1, updatedAt: 1 });
    const on = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent(INBOX)}/spam-filter`,
      { apiKey, method: "PUT", body: JSON.stringify({ enabled: true }) },
    );
    expect(await on.json()).toEqual({
      enabled: true,
      spamMessages: 0,
      hamMessages: 0,
      ready: false,
    });
    await getDb()
      .update(spamModels)
      .set({ spamMessages: 25, hamMessages: 30 })
      .where(eq(spamModels.inbox, INBOX));
    const list = (await (
      await authFetch("/api/admin/inboxes", { apiKey })
    ).json()) as { email: string; spamFilter: unknown }[];
    expect(list.find((row) => row.email === INBOX)?.spamFilter).toEqual({
      enabled: true,
      spamMessages: 25,
      hamMessages: 30,
      ready: true,
    });

    const reset = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent(INBOX)}/spam-filter/reset`,
      { apiKey, method: "POST" },
    );
    expect(await reset.json()).toMatchObject({
      enabled: true,
      spamMessages: 0,
      hamMessages: 0,
    });
  });
});
