import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { emails } from "../db/emails.schema";
import { encryptSecret } from "../lib/crypto";
import { getDb, applyMigrations, cleanDb } from "./helpers";
import { syncAllGmailAccounts } from "../lib/gmail/sync";

// 32 bytes ("0123456789abcdef" twice), base64-encoded — matches
// TOKEN_ENCRYPTION_KEY in vitest.config.test.ts.
const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

function fakeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

function b64url(s: string) {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rawEmail(opts: {
  from: string;
  deliveredTo: string;
  messageId: string;
}) {
  return [
    `From: ${opts.from}`,
    `To: ${opts.deliveredTo}`,
    `Delivered-To: ${opts.deliveredTo}`,
    `Message-ID: ${opts.messageId}`,
    `Subject: Cron-synced subject`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `body text`,
  ].join("\r\n");
}

/** Stubs the three Gmail endpoints needed to sync a single new message. */
function stubGmail(opts: { messageId: string; raw: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.includes("oauth2.googleapis.com/token")) {
        return json({ access_token: "at-1", expires_in: 3599 });
      }
      if (url.includes("/users/me/history")) {
        return json({
          history: [
            {
              id: "9001",
              messagesAdded: [{ message: { id: opts.messageId } }],
            },
          ],
          historyId: "9100",
        });
      }
      if (url.includes(`/users/me/messages/${opts.messageId}`)) {
        return json({
          id: opts.messageId,
          threadId: `t-${opts.messageId}`,
          labelIds: ["INBOX"],
          raw: b64url(opts.raw),
        });
      }
      return json({}, 200);
    }),
  );
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * `worker/src/index.ts`'s `scheduled` export invokes Gmail sync by
 * constructing `drizzle(env.DB, { schema })` and calling
 * `syncAllGmailAccounts(db, env, ctx)` inside its own `ctx.waitUntil`,
 * isolated behind its own `.catch()` — see `handleScheduled(...).catch(...)`
 * just above it in that file for the existing sequence-dispatch precedent
 * this mirrors.
 *
 * Invoking the worker's exported `scheduled()` directly (the real path) was
 * tried first, using both a hand-rolled `ExecutionContext` and (attempting)
 * `cloudflare:test`'s `createExecutionContext`/`waitOnExecutionContext`
 * helpers. Neither works here:
 *   - `cloudflare:test` is not importable in this project's Vitest config
 *     (`Cannot find package 'cloudflare:test'` — `helpers.ts` and every
 *     other test in this suite use `cloudflare:workers`'s `exports`/`env`
 *     instead, and that module is evidently not wired up).
 *   - Calling `exports.default.scheduled(event, env, fakeCtx)` executes (the
 *     handler itself logs that `ctx.waitUntil` is a function of the right
 *     shape), but the `Promise` handed to that `ctx.waitUntil` never runs to
 *     completion on the caller's side: zero rows are ingested, zero calls
 *     reach the stubbed `fetch`, and the callback array captured by the
 *     fake `ctx.waitUntil` closure stays empty — `exports` crosses a real
 *     RPC boundary, and a plain object's methods don't survive that the way
 *     a genuine `ExecutionContext` capability would.
 *
 * So this test exercises `syncAllGmailAccounts` the same way `index.ts`
 * calls it — directly, not through the exported `scheduled()` — which is
 * the documented fallback for this exact situation.
 */
describe("Gmail sync as the scheduled handler invokes it", () => {
  it("ingests a Gmail message via syncAllGmailAccounts(drizzle(env.DB, {schema}), env, ctx)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(gmailAccounts)
      .values({
        id: "acct-1",
        emailAddress: "collector@acme.dev",
        refreshTokenEncrypted: await encryptSecret("rt-1", KEY),
        accessToken: null,
        expiresAt: null,
        historyId: "9000",
        connectedBy: "user-1",
        createdAt: now,
        updatedAt: now,
      });
    await getDb().insert(senderIdentities).values({
      email: "support@acme.dev",
      displayName: "support@acme.dev",
      source: "gmail",
      gmailAccountId: "acct-1",
      gmailGroupAddress: null,
      createdAt: now,
      updatedAt: now,
    });

    stubGmail({
      messageId: "m1",
      raw: rawEmail({
        from: "jane@example.com",
        deliveredTo: "support@acme.dev",
        messageId: "<cron1@example.com>",
      }),
    });

    const cloudflareEnv = env as unknown as CloudflareBindings;
    const db = drizzle(cloudflareEnv.DB, { schema });

    await syncAllGmailAccounts(db, cloudflareEnv, fakeCtx());

    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("support@acme.dev");
    expect(rows[0].gmailMessageId).toBe("m1");

    const [account] = await getDb().select().from(gmailAccounts);
    expect(account.historyId).toBe("9100");
  });
});
