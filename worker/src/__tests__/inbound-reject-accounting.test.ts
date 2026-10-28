// docs/automations.md: a refused message is refused even when recording the
// refusal fails. The accounting (rule match count, audit row) is best effort;
// the SMTP rejection is not.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { handleEmail } from "../email-handler";
import { rules } from "../db/rules.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { setRejectUnknownRecipients } from "../lib/inbound-rejection";
import { applyMigrations, cleanDb, getDb } from "./helpers";

vi.mock("../lib/inbound-rejection", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../lib/inbound-rejection")>();
  return {
    ...original,
    recordInboundRejection: vi.fn(async () => {
      throw new Error("audit write failed");
    }),
  };
});

const INBOX = "support@saasmail.test";

async function deliver(to: string, id: string) {
  const raw = [
    "From: Customer <customer@example.com>",
    `To: ${to}`,
    "Subject: Hello",
    `Message-ID: <${id}@example.com>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
  ].join("\r\n");
  const setReject = vi.fn();
  const message = {
    from: "customer@example.com",
    to,
    raw: new Response(raw).body!,
    rawSize: raw.length,
    headers: new Headers(),
    setReject,
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  await handleEmail(message, env as unknown as CloudflareBindings, ctx);
  return setReject;
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: INBOX,
    displayName: "Support",
    createdAt: now,
    updatedAt: now,
  });
});

describe("a rejection whose accounting throws", () => {
  it("still refuses an unknown recipient", async () => {
    await setRejectUnknownRecipients(getDb(), true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const setReject = await deliver("nobody@saasmail.test", "acct-1");
      expect(setReject).toHaveBeenCalledWith("No such mailbox");
    } finally {
      warn.mockRestore();
    }
  });

  it("still refuses with a reject rule's reason", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(rules)
      .values({
        id: "r",
        name: "Reject",
        inbox: INBOX,
        trigger: "message.received",
        conditions: [],
        actions: [{ type: "reject", reason: "We do not accept this mail" }],
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const setReject = await deliver(INBOX, "acct-2");
      expect(setReject).toHaveBeenCalledWith("We do not accept this mail");
    } finally {
      warn.mockRestore();
    }
  });
});
