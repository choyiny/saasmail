import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import { emails } from "../db/emails.schema";
import { customerPeople, customers } from "../db/customers.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { suggestedReplies } from "../db/suggested-replies.schema";
import { runSuggestedReply } from "../lib/agent/suggest-reply";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
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
      finishReason: "stop" as const,
      usage: USAGE,
      warnings: [],
    }),
  });
}

describe("suggested reply consumer", () => {
  it.each(["FLAG", "MAYBE", "safe"])(
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

  it("creates no row when the screen call errors", async () => {
    const { emailId } = await seed("screen-error-email");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("screen failed");
      },
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
    warn.mockRestore();
  });

  it("acks generation errors without creating a row", async () => {
    const { emailId } = await seed("generation-error-email");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return {
            content: [{ type: "text" as const, text: "SAFE" }],
            finishReason: "stop" as const,
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
    ).resolves.toBeUndefined();

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
