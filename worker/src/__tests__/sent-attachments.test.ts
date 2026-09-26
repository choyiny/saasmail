import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { attachments } from "../db/attachments.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import {
  discardSentAttachments,
  reapOrphanSentAttachments,
  stageSentAttachments,
} from "../lib/sent-attachments";
import type { ParsedFile } from "../lib/multipart-send";
import worker from "../index";

function file(name: string, text = "hello"): ParsedFile {
  const bytes = new TextEncoder().encode(text);
  return {
    filename: name,
    contentType: "text/plain",
    bytes,
    size: bytes.byteLength,
  };
}

async function rowsFor(emailId: string) {
  return getDb()
    .select()
    .from(attachments)
    .where(eq(attachments.emailId, emailId));
}

async function objectsUnder(prefix: string) {
  const listed = await env.R2.list({ prefix });
  return listed.objects.map((o) => o.key);
}

/** env whose R2 binding fails `method` on its `failOnCall`-th call. */
function envWithFailingR2(
  method: "put" | "delete",
  failOnCall = 1,
): CloudflareBindings {
  let calls = 0;
  const r2 = new Proxy(env.R2, {
    get(target, prop) {
      if (prop === method) {
        return async (...args: unknown[]) => {
          calls += 1;
          if (calls === failOnCall) throw new Error("r2 down");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any)[method](...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get(target, prop) {
      return prop === "R2" ? r2 : Reflect.get(target, prop);
    },
  }) as CloudflareBindings;
}

describe("sent attachment lifecycle", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("stages D1 rows and R2 objects under the sent email id", async () => {
    const ids = await stageSentAttachments(
      getDb(),
      env,
      "se-stage",
      [file("a.txt", "alpha")],
      100,
    );
    const rows = await rowsFor("se-stage");
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows[0].kind).toBe("sent");
    expect(rows[0].r2Key.startsWith("attachments/sent/se-stage/")).toBe(true);
    const object = await env.R2.get(rows[0].r2Key);
    expect(await object!.text()).toBe("alpha");
  });

  it("stages nothing for an empty file list", async () => {
    expect(
      await stageSentAttachments(getDb(), env, "se-none", [], 100),
    ).toEqual([]);
    expect(await rowsFor("se-none")).toHaveLength(0);
  });

  it("leaves neither rows nor objects when an R2 write fails", async () => {
    await expect(
      stageSentAttachments(
        getDb(),
        envWithFailingR2("put", 2),
        "se-putfail",
        [file("a.txt"), file("b.txt")],
        100,
      ),
    ).rejects.toThrow("r2 down");
    expect(await rowsFor("se-putfail")).toHaveLength(0);
    expect(await objectsUnder("attachments/sent/se-putfail/")).toEqual([]);
  });

  it("leaves no untracked object when a slow R2 write lands after another fails", async () => {
    // The first put fails at once. The second is slow: it lands right after
    // its key is deleted (the worst case for the cleanup), or after 200 ms if
    // no delete comes first.
    const inFlight: Promise<unknown>[] = [];
    const landWhenDeleted = new Map<string, () => void>();
    let puts = 0;
    const r2 = new Proxy(env.R2, {
      get(target, prop) {
        if (prop === "put") {
          return (key: string, ...rest: unknown[]) => {
            puts += 1;
            if (puts === 1) return Promise.reject(new Error("r2 down"));
            const slow = new Promise<void>((resolve) => {
              landWhenDeleted.set(key, resolve);
              setTimeout(resolve, 200);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            }).then(() => (target as any).put(key, ...rest));
            inFlight.push(slow);
            return slow;
          };
        }
        if (prop === "delete") {
          return async (key: string) => {
            await target.delete(key);
            landWhenDeleted.get(key)?.();
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racyEnv = new Proxy(env, {
      get(target, prop) {
        return prop === "R2" ? r2 : Reflect.get(target, prop);
      },
    }) as CloudflareBindings;

    await expect(
      stageSentAttachments(
        getDb(),
        racyEnv,
        "se-race",
        [file("a.txt"), file("b.txt")],
        100,
      ),
    ).rejects.toThrow("r2 down");
    await Promise.allSettled(inFlight);

    expect(await rowsFor("se-race")).toHaveLength(0);
    expect(await objectsUnder("attachments/sent/se-race/")).toEqual([]);
  });

  it("discards objects and rows", async () => {
    await stageSentAttachments(
      getDb(),
      env,
      "se-discard",
      [file("a.txt")],
      100,
    );
    await discardSentAttachments(getDb(), env, "se-discard");
    expect(await rowsFor("se-discard")).toHaveLength(0);
    expect(await objectsUnder("attachments/sent/se-discard/")).toEqual([]);
  });

  it("deletes the R2 object before the D1 row (row survives an R2 failure)", async () => {
    await stageSentAttachments(getDb(), env, "se-order", [file("a.txt")], 100);
    await expect(
      discardSentAttachments(getDb(), envWithFailingR2("delete"), "se-order"),
    ).rejects.toThrow("r2 down");
    // Still tracked, so the reaper can retry the R2 delete later.
    expect(await rowsFor("se-order")).toHaveLength(1);
  });

  it("reaps only old sent attachments with no sent_emails and no outbox row", async () => {
    const now = 100_000;
    const db = getDb();
    const old = now - 7200;
    await stageSentAttachments(db, env, "se-orphan", [file("o.txt")], old);
    await stageSentAttachments(db, env, "se-young", [file("y.txt")], now - 60);
    await stageSentAttachments(db, env, "se-has-sent", [file("s.txt")], old);
    await stageSentAttachments(db, env, "se-has-outbox", [file("b.txt")], old);
    await db.insert(sentEmails).values({
      id: "se-has-sent",
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      subject: "Hi",
      status: "sent",
      sentAt: old,
      createdAt: old,
    });
    await db.insert(outboxEmails).values({
      id: "ob-live",
      sentEmailId: "se-has-outbox",
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      subject: "Hi",
      transactional: 1,
      status: "pending",
      attempts: 1,
      nextRetryAt: now,
      createdAt: old,
      updatedAt: old,
    });
    await db.insert(attachments).values({
      id: "inbound-old",
      emailId: "no-such-email",
      kind: "inbound",
      filename: "in.txt",
      contentType: "text/plain",
      size: 1,
      r2Key: "attachments/inbound/in.txt",
      contentId: null,
      createdAt: old,
    });

    const reaped = await reapOrphanSentAttachments(db, env, now);

    expect(reaped).toBe(1);
    expect(await rowsFor("se-orphan")).toHaveLength(0);
    expect(await objectsUnder("attachments/sent/se-orphan/")).toEqual([]);
    expect(await rowsFor("se-young")).toHaveLength(1);
    expect(await rowsFor("se-has-sent")).toHaveLength(1);
    expect(await rowsFor("se-has-outbox")).toHaveLength(1);
    expect(await rowsFor("no-such-email")).toHaveLength(1);
  });
});

describe("scheduled cron", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("reaps orphan sent attachments", async () => {
    const old = Math.floor(Date.now() / 1000) - 7200;
    await stageSentAttachments(getDb(), env, "se-cron", [file("c.txt")], old);
    const waits: Promise<unknown>[] = [];
    await worker.scheduled!(
      { cron: "0 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
      env,
      {
        waitUntil: (p: Promise<unknown>) => {
          waits.push(p);
        },
      } as ExecutionContext,
    );
    await Promise.all(waits);
    expect(await rowsFor("se-cron")).toHaveLength(0);
    expect(await objectsUnder("attachments/sent/se-cron/")).toEqual([]);
  });
});
