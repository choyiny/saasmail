import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import { emails } from "../db/emails.schema";
import { customerPeople, customers } from "../db/customers.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { suggestedReplies } from "../db/suggested-replies.schema";
import {
  postProcessSuggestedReply,
  runSuggestedReply,
} from "../lib/agent/suggest-reply";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 5,
    text: 5,
    reasoning: undefined,
  },
};

beforeAll(applyMigrations);
beforeEach(cleanDb);

async function seed(emailId = "suggest-email") {
  const inbox = "support@example.com";
  const now = Math.floor(Date.now() / 1000);
  await createTestPerson({
    id: "suggest-person",
    email: "customer@example.com",
  });
  await createTestEmail({
    id: emailId,
    personId: "suggest-person",
    recipient: inbox,
    subject: "Question",
    bodyText: "Can you send me the invoice?",
  });
  await getDb().insert(senderIdentities).values({
    email: inbox,
    agentAutodraft: 1,
    agentInstructions: "Keep it concise.",
    createdAt: now,
    updatedAt: now,
  });
  return { inbox, emailId };
}

function textModel(outputs: string[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: outputs[call++] ?? "" }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
}

describe("suggested reply post-processing", () => {
  it("drops a trailing placeholder and its closing phrase", () => {
    expect(
      postProcessSuggestedReply(
        "Thanks for the details.\n\nBest regards,\n[Your Name]",
      ),
    ).toEqual({
      bodyText: "Thanks for the details.",
      hasPlaceholder: false,
    });
    expect(
      postProcessSuggestedReply("I can help with that.\n[Company]"),
    ).toEqual({
      bodyText: "I can help with that.",
      hasPlaceholder: false,
    });
  });

  it("keeps legitimate bracketed labels but flags actual placeholders", () => {
    expect(
      postProcessSuggestedReply(
        "Please send this to [Team] and keep [Role] in the copied template.",
      ),
    ).toEqual({
      bodyText:
        "Please send this to [Team] and keep [Role] in the copied template.",
      hasPlaceholder: false,
    });
    expect(postProcessSuggestedReply("Hello [Your Name]").hasPlaceholder).toBe(
      true,
    );
    expect(
      postProcessSuggestedReply("Hello [Customer Name]").hasPlaceholder,
    ).toBe(true);
    expect(
      postProcessSuggestedReply("Use [insert account number]").hasPlaceholder,
    ).toBe(true);
    expect(postProcessSuggestedReply("Hello [NAME]").hasPlaceholder).toBe(true);
    expect(postProcessSuggestedReply("Hello [X]").hasPlaceholder).toBe(true);
  });

  it("flags placeholders that remain inside substantive copy", () => {
    expect(
      postProcessSuggestedReply(
        "Please visit [Company Portal] and ask for [Your Name] if you need help.",
      ).hasPlaceholder,
    ).toBe(true);
  });
});

describe("suggested reply consumer", () => {
  it.each(["FLAG", "MAYBE", "UNSAFE"])(
    "creates no row when the screen returns %j",
    async (screenOutput) => {
      const { emailId } = await seed();
      const model = textModel([screenOutput, "This must not be generated."]);

      await runSuggestedReply(
        getDb(),
        env as unknown as CloudflareBindings,
        emailId,
        model,
      );

      const rows = await getDb()
        .select()
        .from(suggestedReplies)
        .where(eq(suggestedReplies.emailId, emailId));
      expect(rows).toHaveLength(0);
      expect(model.doGenerateCalls).toHaveLength(1);
    },
  );

  it("disables reasoning for the screen and accepts a SAFE first word after reasoning", async () => {
    const { emailId } = await seed("reasoning-screen-email");
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1;
        return {
          content:
            call === 1
              ? [
                  {
                    type: "reasoning" as const,
                    text: "This content is ordinary.",
                  },
                  { type: "text" as const, text: "**SAFE.**" },
                ]
              : [{ type: "text" as const, text: "A safe draft." }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    await runSuggestedReply(
      getDb(),
      env as unknown as CloudflareBindings,
      emailId,
      model,
    );

    const [row] = await getDb()
      .select()
      .from(suggestedReplies)
      .where(eq(suggestedReplies.emailId, emailId));
    expect(row?.bodyText).toBe("A safe draft.");
    expect(model.doGenerateCalls[0]).toMatchObject({
      maxOutputTokens: 256,
      reasoning: "none",
      providerOptions: {
        "workers-ai": {
          chat_template_kwargs: { enable_thinking: false },
        },
      },
    });
    expect(model.doGenerateCalls[1]).toMatchObject({
      maxOutputTokens: 4096,
      reasoning: "none",
      providerOptions: {
        "workers-ai": {
          chat_template_kwargs: { enable_thinking: false },
        },
      },
    });
  });

  it("fails closed when the screen returns reasoning without final text", async () => {
    const { emailId } = await seed("reasoning-only-screen-email");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "reasoning" as const,
            text: "A hidden verdict must never be used.",
          },
        ],
        finishReason: { unified: "length" as const, raw: "length" },
        usage: USAGE,
        warnings: [],
      }),
    });

    await runSuggestedReply(
      getDb(),
      env as unknown as CloudflareBindings,
      emailId,
      model,
    );

    expect(
      await getDb()
        .select()
        .from(suggestedReplies)
        .where(eq(suggestedReplies.emailId, emailId)),
    ).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "[suggested-reply] injection screen returned empty text; skipping:",
      expect.objectContaining({
        reasoningLength: expect.any(Number),
      }),
    );
    warn.mockRestore();
  });

  it("stores nothing when reply generation returns empty final text", async () => {
    const { emailId } = await seed("empty-generation-email");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = textModel(["SAFE", ""]);

    await runSuggestedReply(
      getDb(),
      env as unknown as CloudflareBindings,
      emailId,
      model,
    );

    expect(
      await getDb()
        .select()
        .from(suggestedReplies)
        .where(eq(suggestedReplies.emailId, emailId)),
    ).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      "[suggested-reply] generation returned empty text; skipping:",
      expect.objectContaining({ reasoningLength: 0 }),
    );
    warn.mockRestore();
  });

  it("surfaces screen call errors for queue retry without creating a row", async () => {
    const { emailId } = await seed("screen-error-email");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("screen failed");
      },
    });

    await expect(
      runSuggestedReply(
        getDb(),
        env as unknown as CloudflareBindings,
        emailId,
        model,
      ),
    ).rejects.toThrow("screen failed");

    expect(
      await getDb()
        .select()
        .from(suggestedReplies)
        .where(eq(suggestedReplies.emailId, emailId)),
    ).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(1);
    warn.mockRestore();
  });

  it("surfaces generation errors for queue retry without creating a row", async () => {
    const { emailId } = await seed("generation-error-email");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return {
            content: [{ type: "text" as const, text: "SAFE" }],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: USAGE,
            warnings: [],
          };
        }
        throw new Error("generation failed");
      },
    });

    await expect(
      runSuggestedReply(
        getDb(),
        env as unknown as CloudflareBindings,
        emailId,
        model,
      ),
    ).rejects.toThrow("generation failed");

    expect(
      await getDb()
        .select()
        .from(suggestedReplies)
        .where(eq(suggestedReplies.emailId, emailId)),
    ).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(2);
    warn.mockRestore();
  });

  it("uses HTML text when the current message has no text body", async () => {
    const { emailId } = await seed("html-only-email");
    await getDb()
      .update(emails)
      .set({
        bodyText: null,
        bodyHtml: "<p>Hello <strong>there</strong> &amp; welcome.</p>",
      })
      .where(eq(emails.id, emailId));
    const model = textModel(["SAFE", "Thanks for the note."]);

    await runSuggestedReply(
      getDb(),
      env as unknown as CloudflareBindings,
      emailId,
      model,
    );

    const [row] = await getDb()
      .select()
      .from(suggestedReplies)
      .where(eq(suggestedReplies.emailId, emailId));
    expect(row?.bodyText).toBe("Thanks for the note.");
    expect(JSON.stringify(model.doGenerateCalls[0])).toContain(
      "Hello there & welcome.",
    );
    expect(JSON.stringify(model.doGenerateCalls[1])).toContain(
      "Hello there & welcome.",
    );
  });

  it("creates a pending row and realtime notification on the happy path", async () => {
    const { emailId } = await seed("happy-suggest-email");
    await createTestUser({
      id: "suggest-admin",
      email: "suggest-admin@example.com",
      role: "admin",
    });
    const getSpy = vi.spyOn(env.NOTIFICATIONS_HUB, "get");
    const model = textModel(["SAFE\n", "Absolutely — I can send the invoice."]);

    await runSuggestedReply(
      getDb(),
      env as unknown as CloudflareBindings,
      emailId,
      model,
    );

    const [row] = await getDb()
      .select()
      .from(suggestedReplies)
      .where(eq(suggestedReplies.emailId, emailId));
    expect(row).toMatchObject({
      emailId,
      inbox: "support@example.com",
      bodyText: "Absolutely — I can send the invoice.",
      status: "pending",
      model: "test",
    });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(getSpy).toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it("uses linked-address history but keeps it scoped to the inbound inbox", async () => {
    const { emailId, inbox } = await seed("linked-history-email");
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await createTestPerson({
      id: "suggest-alias",
      email: "customer.alias@example.com",
    });
    await createTestEmail({
      id: "suggest-alias-allowed",
      personId: "suggest-alias",
      recipient: inbox,
      subject: "Earlier linked question",
      bodyText: "linked-history-visible-token",
      messageId: "suggest-alias-allowed@example.test",
    });
    await createTestEmail({
      id: "suggest-alias-denied",
      personId: "suggest-alias",
      recipient: "private@example.com",
      subject: "Private linked question",
      bodyText: "linked-history-denied-token",
      messageId: "suggest-alias-denied@example.test",
    });
    await db.insert(customers).values({
      id: "suggest-customer",
      displayName: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(customerPeople).values([
      {
        customerId: "suggest-customer",
        personId: "suggest-person",
        linkedBy: null,
        linkedAt: now,
      },
      {
        customerId: "suggest-customer",
        personId: "suggest-alias",
        linkedBy: null,
        linkedAt: now,
      },
    ]);

    const model = textModel(["SAFE", "A linked-context reply."]);
    await runSuggestedReply(
      db,
      env as unknown as CloudflareBindings,
      emailId,
      model,
    );

    const generationCall = JSON.stringify(model.doGenerateCalls[1]);
    expect(generationCall).toContain("linked-history-visible-token");
    expect(generationCall).not.toContain("linked-history-denied-token");
  });

  it("skips a draft when a placeholder remains in the body", async () => {
    const { emailId } = await seed("placeholder-draft-email");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = textModel([
      "SAFE",
      "Open Settings, then Billing and ask [Your Name] for help.",
    ]);

    await runSuggestedReply(
      getDb(),
      env as unknown as CloudflareBindings,
      emailId,
      model,
    );

    expect(
      await getDb()
        .select()
        .from(suggestedReplies)
        .where(eq(suggestedReplies.emailId, emailId)),
    ).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "[suggested-reply] generation contained a bracketed placeholder; skipping",
    );
    warn.mockRestore();
  });

  it("tells the drafting model not to invent facts or add a signature", async () => {
    const { emailId } = await seed("grounded-prompt-email");
    const model = textModel(["SAFE", "We will follow up with the details."]);

    await runSuggestedReply(
      getDb(),
      env as unknown as CloudflareBindings,
      emailId,
      model,
    );

    const generationCall = JSON.stringify(model.doGenerateCalls[1]);
    expect(generationCall).toContain(
      "Only state facts that appear in the quoted messages or the inbox instructions",
    );
    expect(generationCall).toContain(
      "The configured inbox signature is added when the reply is sent",
    );
  });

  it("is idempotent on redelivery", async () => {
    const { emailId } = await seed("redelivery-email");
    const model = textModel(["SAFE", "A draft reply."]);

    await runSuggestedReply(
      getDb(),
      env as unknown as CloudflareBindings,
      emailId,
      model,
    );
    await runSuggestedReply(
      getDb(),
      env as unknown as CloudflareBindings,
      emailId,
      model,
    );

    const rows = await getDb()
      .select()
      .from(suggestedReplies)
      .where(eq(suggestedReplies.emailId, emailId));
    expect(rows).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(2);
  });
});
