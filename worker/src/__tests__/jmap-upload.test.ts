import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { users } from "../db/auth.schema";
import { jmapBlobs } from "../db/jmap-blobs.schema";
import { JMAP_ID_PATTERN, parseUploadBlobId } from "../jmap/public-ids";
import { validateJmapUploadOrigin } from "../jmap/http";
import { createEmailSender } from "../lib/email-sender";
import {
  parseDeclaredLength,
  readCappedBody,
  reapExpiredUploads,
  storeUpload,
  uploadMediaType,
  uploadTooLargeProblem,
  UPLOAD_TTL_SECONDS,
} from "../jmap/upload";
import worker from "../index";
import { acct, expectAllJmapIdsValid } from "./jmap-ids";

describe("jmap_blobs table", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("keeps an upload row after its user is deleted, for the reaper", async () => {
    const { userId } = await createTestUser({
      id: "aaa-uploader",
      email: "uploader@example.com",
    });
    await getDb()
      .insert(jmapBlobs)
      .values({
        id: "blob-1",
        userId,
        type: "text/plain",
        size: 5,
        r2Key: `jmap-uploads/${userId}/blob-1`,
        createdAt: 100,
      });
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(1);

    // No foreign key on purpose: a cascade would drop the row and leave its R2
    // object untracked. The age-based reaper deletes both within 24 hours.
    await getDb().delete(users).where(eq(users.id, userId));
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(1);
  });
});

function streamOf(bytes: BodyInit): ReadableStream<Uint8Array> {
  return new Response(bytes).body!;
}

/** env whose R2 `put` always fails. */
function envWithFailingPut(): CloudflareBindings {
  const r2 = new Proxy(env.R2, {
    get(target, prop) {
      if (prop === "put") {
        return async () => {
          throw new Error("r2 down");
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

async function uploadObjects(userId: string): Promise<string[]> {
  const listed = await env.R2.list({ prefix: `jmap-uploads/${userId}/` });
  return listed.objects.map((object) => object.key);
}

/**
 * cleanDb() only empties D1; R2 objects outlive it, so a test that lists the
 * whole upload prefix would see an earlier test's objects. Wipe it between
 * tests, the same way list-import.test.ts clears its own prefix.
 */
async function clearUploadObjects(): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.R2.list({ prefix: "jmap-uploads/", cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await env.R2.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

describe("storeUpload", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    await clearUploadObjects();
  });

  const base = {
    userId: "aaa-uploader",
    accountId: "aACCOUNT",
    contentType: "text/plain",
    declaredLength: null,
    maxBytes: 8,
    now: 1000,
  };

  it("stores the row first and the bytes under jmap-uploads/<user>/<id>", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    const result = await storeUpload(getDb(), env, {
      ...base,
      body: streamOf(new TextEncoder().encode("hello")),
    });
    expect(result.tooLargeLimit).toBeNull();
    expect(result.blob).toMatchObject({
      accountId: "aACCOUNT",
      type: "text/plain",
      size: 5,
    });
    expect(result.blob!.blobId).toMatch(JMAP_ID_PATTERN);
    const id = parseUploadBlobId(result.blob!.blobId)!;
    const [row] = await getDb()
      .select()
      .from(jmapBlobs)
      .where(eq(jmapBlobs.id, id));
    expect(row).toMatchObject({
      userId: "aaa-uploader",
      size: 5,
      createdAt: 1000,
      r2Key: `jmap-uploads/aaa-uploader/${id}`,
    });
    const object = await env.R2.get(row.r2Key);
    expect(await object!.text()).toBe("hello");
  });

  it("accepts a zero-byte body", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    const result = await storeUpload(getDb(), env, {
      ...base,
      body: streamOf(new Uint8Array(0)),
    });
    expect(result.blob).toMatchObject({ size: 0 });
  });

  it("refuses a body over the limit found while reading, and stores nothing", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    // No declared length: only the read-loop counter can catch this.
    const result = await storeUpload(getDb(), env, {
      ...base,
      body: streamOf(new Uint8Array(9)),
    });
    expect(result).toEqual({ blob: null, tooLargeLimit: 8 });
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(0);
    expect(await uploadObjects("aaa-uploader")).toEqual([]);
  });

  it("refuses a declared length over the limit without reading the body", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    let pulled = false;
    // highWaterMark 0: the stream only pulls when someone reads it.
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await storeUpload(getDb(), env, {
      ...base,
      declaredLength: 9,
      body,
    });
    expect(result).toEqual({ blob: null, tooLargeLimit: 8 });
    expect(pulled).toBe(false);
  });

  it("drops the row when the R2 write fails", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    await expect(
      storeUpload(getDb(), envWithFailingPut(), {
        ...base,
        body: streamOf(new TextEncoder().encode("x")),
      }),
    ).rejects.toThrow("r2 down");
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(0);
  });

  it("reads bodies up to exactly the limit", async () => {
    expect(await readCappedBody(streamOf(new Uint8Array(8)), 8)).toHaveLength(
      8,
    );
    expect(await readCappedBody(streamOf(new Uint8Array(9)), 8)).toBeNull();
    expect(await readCappedBody(null, 8)).toHaveLength(0);
  });

  it("normalises the media type and the declared length", () => {
    expect(uploadMediaType("image/png")).toBe("image/png");
    expect(uploadMediaType(" text/plain; charset=utf-8 ")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(uploadMediaType(null)).toBe("application/octet-stream");
    expect(uploadMediaType("")).toBe("application/octet-stream");
    expect(uploadMediaType("text/plain\r\nX-Evil: 1")).toBe(
      "application/octet-stream",
    );
    expect(uploadMediaType("a".repeat(256))).toBe("application/octet-stream");
    expect(parseDeclaredLength("12")).toBe(12);
    expect(parseDeclaredLength(null)).toBeNull();
    expect(parseDeclaredLength("-1")).toBeNull();
    expect(parseDeclaredLength("abc")).toBeNull();
  });

  it("describes the limit in the 413 problem body", async () => {
    const response = uploadTooLargeProblem(8);
    expect(response.status).toBe(413);
    expect(response.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 413,
      limit: "maxSizeUpload",
      maxSize: 8,
    });
  });
});

async function upload(
  apiKey: string | undefined,
  accountId: string,
  bytes: BodyInit,
  type = "text/plain",
  trailingSlash = true,
) {
  return authFetch(`/jmap/upload/${accountId}${trailingSlash ? "/" : ""}`, {
    method: "POST",
    apiKey,
    headers: { "Content-Type": type },
    body: bytes,
  });
}

describe("POST /jmap/upload/{accountId}/", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    await clearUploadObjects();
  });

  it("uploads and returns the RFC 8620 §6.1 object", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "aaa-uploader",
      email: "uploader@example.com",
    });
    const response = await upload(
      apiKey,
      acct(userId),
      new TextEncoder().encode("hello"),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      accountId: acct(userId),
      blobId: expect.stringMatching(/^U/),
      type: "text/plain",
      size: 5,
    });
    expectAllJmapIdsValid(body);
  });

  it("accepts the upload URL without the trailing slash too", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "aaa-uploader",
      email: "uploader@example.com",
    });
    const response = await upload(
      apiKey,
      acct(userId),
      new TextEncoder().encode("x"),
      "text/plain",
      false,
    );
    expect(response.status).toBe(201);
  });

  it("accepts a zero-byte upload", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "aaa-uploader",
      email: "uploader@example.com",
    });
    const response = await upload(apiKey, acct(userId), new Uint8Array(0));
    expect(response.status).toBe(201);
    const created = (await response.json()) as { size: number };
    expect(created.size).toBe(0);
    // Downloading it back empty is pinned in Task 5 (jmap-blobs.test.ts).
  });

  it("answers 401 without auth and 403 for another account", async () => {
    const { userId } = await createTestUser({
      id: "aaa-uploader",
      email: "uploader@example.com",
    });
    const other = await createTestUser({
      id: "bbb-reader",
      email: "reader@example.com",
    });
    expect(
      (await upload(undefined, acct(userId), new Uint8Array(1))).status,
    ).toBe(401);
    const wrong = await upload(other.apiKey, acct(userId), new Uint8Array(1));
    expect(wrong.status).toBe(403);
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(0);
  });

  it("requires a trusted Origin for session-cookie uploads only", () => {
    const request = (origin?: string) =>
      new Request("http://localhost/jmap/upload/a/", {
        method: "POST",
        headers: origin ? { Origin: origin } : {},
        body: "x",
      });
    const bindings = env as unknown as CloudflareBindings;
    expect(
      validateJmapUploadOrigin(request(), bindings, "session")?.status,
    ).toBe(403);
    expect(
      validateJmapUploadOrigin(
        request("https://evil.example"),
        bindings,
        "session",
      )?.status,
    ).toBe(403);
    expect(
      validateJmapUploadOrigin(request(env.BASE_URL), bindings, "session"),
    ).toBeNull();
    expect(validateJmapUploadOrigin(request(), bindings, "apiKey")).toBeNull();
  });

  // The route -> 413 wiring is the only thing a client actually sees, so pin
  // it over HTTP rather than trusting storeUpload's unit coverage alone.
  // Review Focus #1: an over-limit body must leave no row and no object, and
  // a lying/absent Content-Length must still be caught by the read counter.
  it("answers 413 over the limit and stores nothing, however the length is declared", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "aaa-uploader",
      email: "uploader@example.com",
    });
    const limit = createEmailSender(env).maxAttachmentBytes();
    const over = new Uint8Array(limit + 1);

    // (a) An honest Content-Length: refused before the body is read.
    const declared = await authFetch(`/jmap/upload/${acct(userId)}/`, {
      method: "POST",
      apiKey,
      headers: { "Content-Type": "text/plain" },
      body: over,
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({
      status: 413,
      limit: "maxSizeUpload",
      maxSize: limit,
    });

    // (b) A stream that lies: chunked, so no Content-Length reaches us and only
    // the counter inside the read loop can refuse it. `duplex` is required for a
    // streaming request body but is missing from the Workers RequestInit type.
    const lying = await authFetch(`/jmap/upload/${acct(userId)}/`, {
      method: "POST",
      apiKey,
      headers: { "Content-Type": "text/plain" },
      duplex: "half",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(limit));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }) as unknown as BodyInit,
    } as unknown as RequestInit & { apiKey: string });
    expect(lying.status).toBe(413);

    expect(await getDb().select().from(jmapBlobs)).toHaveLength(0);
    expect(await uploadObjects(userId)).toEqual([]);
  });
});

describe("upload reaper", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    await clearUploadObjects();
  });

  async function seed(id: string, createdAt: number) {
    const r2Key = `jmap-uploads/aaa-uploader/${id}`;
    await getDb().insert(jmapBlobs).values({
      id,
      userId: "aaa-uploader",
      type: "text/plain",
      size: 1,
      r2Key,
      createdAt,
    });
    await env.R2.put(r2Key, new Uint8Array([1]));
  }

  it("deletes uploads older than 24 hours, object first, and keeps younger ones", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    const now = 1_000_000;
    await seed("old", now - UPLOAD_TTL_SECONDS - 1);
    await seed("young", now - 60);

    expect(await reapExpiredUploads(getDb(), env, now)).toBe(1);

    const left = await getDb().select().from(jmapBlobs);
    expect(left.map((row) => row.id)).toEqual(["young"]);
    expect(await uploadObjects("aaa-uploader")).toEqual([
      "jmap-uploads/aaa-uploader/young",
    ]);
  });

  it("reaps more rows than one D1 statement can bind", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    for (let index = 0; index < 120; index += 1) {
      await seed(`old-${index}`, 1);
    }
    expect(await reapExpiredUploads(getDb(), env, 1_000_000)).toBe(120);
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(0);
  });

  it("runs in the hourly cron", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    await seed(
      "cron-old",
      Math.floor(Date.now() / 1000) - UPLOAD_TTL_SECONDS - 60,
    );
    const waits: Promise<unknown>[] = [];
    await worker.scheduled!(
      { cron: "0 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          waits.push(promise);
        },
      } as ExecutionContext,
    );
    await Promise.all(waits);
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(0);
    expect(await uploadObjects("aaa-uploader")).toEqual([]);
  });
});
