import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { users } from "../db/auth.schema";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import { publishWebDraft } from "../jmap/web-drafts";
import { applyMigrations, authFetch, cleanDb, getDb } from "./helpers";
import { acct, sys } from "./jmap-ids";
import { drafts } from "../db/drafts.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { parseDraftEmailId, publicDraftEmailId } from "../jmap/public-ids";
import {
  INBOX,
  draftCreate,
  jmapCall,
  seedAccount,
} from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

describe("shared drafts: mail-client drafts in the web, read-only", () => {
  let authorId: string;
  let apiKey: string;
  let memberKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({
      authorId,
      authorApiKey: apiKey,
      memberApiKey: memberKey,
    } = await seedAccount());
  });

  async function api(path: string, init: RequestInit = {}, key = apiKey) {
    const res = await authFetch(path, { apiKey: key, ...init });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function clientDraft(overrides: Record<string, unknown> = {}) {
    const res = (await jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          create: {
            d: draftCreate({
              bcc: [{ name: null, email: "boss@example.com" }],
              ...overrides,
            }),
          },
        },
        "c",
      ],
    ])) as Responses;
    return parseDraftEmailId(res[0][1].created.d.id)!;
  }

  function moveTo(internal: string, role: "trash" | "drafts") {
    return jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          update: {
            [publicDraftEmailId(internal)]: {
              mailboxIds: { [sys(INBOX, role)]: true },
            },
          },
        },
        "m",
      ],
    ]);
  }

  it("lists a mail-client draft and previews it read-only", async () => {
    const internal = await clientDraft();
    const list = await api(
      `/api/drafts/list?inbox=${encodeURIComponent(INBOX)}&includeMailClient=1`,
    );
    expect(list.body.drafts).toEqual([
      expect.objectContaining({
        contextKey: `jmap:${internal}`,
        toAddress: "alice@example.com",
        subject: "Quarterly numbers",
      }),
    ]);
    const preview = await api(
      `/api/drafts/jmap-preview?contextKey=${encodeURIComponent(`jmap:${internal}`)}`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.draft).toMatchObject({
      contextKey: `jmap:${internal}`,
      subject: "Quarterly numbers",
      to: [{ email: "alice@example.com", name: "Alice Example" }],
      bcc: [{ email: "boss@example.com", name: null }],
      text: "Numbers attached.",
    });
    // Previewing changes nothing and creates no web copy.
    expect(await getDb().select().from(drafts)).toEqual([]);
  });

  it("doesn't preview another user's draft, a trashed one, or an unknown id", async () => {
    const internal = await clientDraft();
    const path = `/api/drafts/jmap-preview?contextKey=${encodeURIComponent(`jmap:${internal}`)}`;
    expect((await api(path, {}, memberKey)).status).toBe(404);
    await moveTo(internal, "trash");
    expect((await api(path)).status).toBe(404);
    expect(
      (await api("/api/drafts/jmap-preview?contextKey=jmap%3Anope")).status,
    ).toBe(404);
  });

  it("deletes a listed mail-client draft, but never one moved to Trash", async () => {
    const listed = await clientDraft();
    const trashed = await clientDraft({ subject: "Other" });
    await moveTo(trashed, "trash");
    for (const internal of [listed, trashed]) {
      const res = await authFetch(
        `/api/drafts?contextKey=${encodeURIComponent(`jmap:${internal}`)}`,
        { apiKey, method: "DELETE" },
      );
      expect(res.status).toBe(200);
    }
    const left = await getDb().select().from(jmapDrafts);
    expect(left.map((d) => d.id)).toEqual([trashed]);
  });

  it("a mail-client draft can't be saved over from the web", async () => {
    const internal = await clientDraft();
    const res = await api("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({
        contextKey: `jmap:${internal}`,
        subject: "Overwritten",
      }),
    });
    expect(res.status).toBe(400);
    expect(await getDb().select().from(drafts)).toEqual([]);
  });

  it("the plain list stays paged over the web's own drafts", async () => {
    await clientDraft();
    const plain = await api(
      `/api/drafts/list?inbox=${encodeURIComponent(INBOX)}`,
    );
    expect(plain.body.drafts).toEqual([]);
  });

  describe("web drafts published to JMAP", () => {
    const BASE = {
      contextKey: "draft:one",
      fromAddress: INBOX,
      to: "alice@example.com",
      cc: [],
      subject: "Plans",
      bodyHtml: "<p>Hi</p>",
      bodyText: "",
    };

    const save = (body: Record<string, unknown>) =>
      api("/api/drafts", { method: "PUT", body: JSON.stringify(body) });
    const publish = () =>
      api("/api/drafts/publish", {
        method: "POST",
        body: JSON.stringify({ contextKey: "draft:one" }),
      });
    const linked = async () =>
      (
        await getDb()
          .select()
          .from(drafts)
          .where(eq(drafts.contextKey, "draft:one"))
      )[0].jmapDraftId!;

    it("a save with the same values (as the composer sends them) makes no revision", async () => {
      await save(BASE);
      expect((await publish()).body.status).toBe("published");
      const first = await linked();
      await save(BASE);
      expect((await publish()).body.status).toBe("unchanged");
      expect(await linked()).toBe(first);
    });

    /** An env whose DB runs `hook` just before the publish links its revision. */
    function hookedEnv(hook: () => Promise<void>) {
      const realDb = env.DB;
      const DB = new Proxy(realDb, {
        get(target, prop) {
          if (prop === "prepare") {
            return (query: string) => {
              const statement = target.prepare(query);
              if (!/^\s*UPDATE drafts/.test(query)) return statement;
              return {
                bind: (...args: unknown[]) => {
                  const bound = statement.bind(...args);
                  return {
                    run: async () => {
                      await hook();
                      return bound.run();
                    },
                  };
                },
              };
            };
          }
          const value = (target as any)[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return { ...env, DB } as any;
    }

    async function publishWhile(hook: () => Promise<void>) {
      const db = getDb();
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, authorId));
      const allowed = await resolveAllowedInboxes(db, user);
      const hooked = hookedEnv(hook);
      return publishWebDraft(
        drizzle(hooked.DB),
        hooked,
        allowed,
        authorId,
        "draft:one",
      );
    }

    it("a draft a mail client deletes mid-publish isn't brought back", async () => {
      await save(BASE);
      await publish();
      const first = await linked();
      await save({ ...BASE, subject: "Edited" });
      const outcome = await publishWhile(async () => {
        await jmapCall(authorId, [
          [
            "Email/set",
            {
              accountId: acct(authorId),
              destroy: [publicDraftEmailId(first)],
            },
            "x",
          ],
        ]);
      });
      expect(outcome.status).toBe("gone");
      expect(await getDb().select().from(jmapDrafts)).toEqual([]);
    });

    it("a draft a mail client trashes mid-publish stays in Trash, and publishes again once back", async () => {
      await save(BASE);
      await publish();
      const first = await linked();
      await save({ ...BASE, subject: "Edited" });
      const outcome = await publishWhile(async () => {
        await moveTo(first, "trash");
      });
      expect(outcome.status).toBe("gone");
      let all = await getDb().select().from(jmapDrafts);
      expect(all.map((d) => [d.id, d.mailboxRole])).toEqual([[first, "trash"]]);
      expect(await linked()).toBe(first);

      await moveTo(first, "drafts");
      expect((await publish()).body.status).toBe("published");
      all = await getDb().select().from(jmapDrafts);
      expect(all).toHaveLength(1);
      expect(all[0].mailboxRole).toBe("drafts");
    });

    it("a draft a mail client moved to Trash stays there; moved back, publishing resumes", async () => {
      await save(BASE);
      await publish();
      const first = await linked();
      await moveTo(first, "trash");
      await save({ ...BASE, subject: "Edited" });
      expect((await publish()).body.status).toBe("gone");
      let all = await getDb().select().from(jmapDrafts);
      expect(all.map((d) => [d.id, d.mailboxRole])).toEqual([[first, "trash"]]);

      await moveTo(first, "drafts");
      expect((await publish()).body.status).toBe("published");
      all = await getDb().select().from(jmapDrafts);
      expect(all).toHaveLength(1);
      expect(all[0].id).not.toBe(first);
      expect(all[0].mailboxRole).toBe("drafts");
    });
  });
});
