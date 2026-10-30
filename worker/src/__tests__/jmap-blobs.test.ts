import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestAttachment,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { jmapBlobs } from "../db/jmap-blobs.schema";
import {
  downloadContentType,
  downloadFilename,
  readBlobBytes,
  resolveReadableBlob,
} from "../jmap/blobs";
import { acct, att, upl } from "./jmap-ids";

const INBOX = "mine@saasmail.test";

async function seedUpload(userId: string, id: string, text: string) {
  const r2Key = `jmap-uploads/${userId}/${id}`;
  await getDb()
    .insert(jmapBlobs)
    .values({
      id,
      userId,
      type: "text/plain",
      size: new TextEncoder().encode(text).byteLength,
      r2Key,
      createdAt: Math.floor(Date.now() / 1000),
    });
  await env.R2.put(r2Key, new TextEncoder().encode(text));
  return r2Key;
}

async function seedAttachment() {
  await createTestPerson({ id: "person-1", email: "alice@example.com" });
  await createTestEmail({
    id: "mail-1",
    personId: "person-1",
    recipient: INBOX,
  });
  const attachment = await createTestAttachment({
    id: "att-1",
    emailId: "mail-1",
    filename: "report.txt",
    contentType: "text/plain",
    size: 6,
    r2Key: "jmap-blob-test/report.txt",
  });
  await env.R2.put(attachment.r2Key, new TextEncoder().encode("report"));
  return attachment;
}

describe("resolveReadableBlob", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("resolves an upload for its owner only, even against an admin", async () => {
    const owner = await createTestUser({
      id: "aaa-uploader",
      email: "uploader@example.com",
    });
    const other = await createTestUser({
      id: "bbb-reader",
      email: "reader@example.com",
    });
    const r2Key = await seedUpload(owner.userId, "up-1", "hello");

    const mine = await resolveReadableBlob(
      getDb(),
      { isAdmin: true },
      owner.userId,
      upl("up-1"),
    );
    expect(mine).toEqual({
      blobId: upl("up-1"),
      type: "text/plain",
      size: 5,
      name: null,
      source: { r2Key },
    });
    expect(
      await resolveReadableBlob(
        getDb(),
        { isAdmin: true },
        other.userId,
        upl("up-1"),
      ),
    ).toBeNull();
  });

  it("resolves attachments through the inbox permission check", async () => {
    const { userId } = await createTestUser({ id: "aaa-uploader" });
    const attachment = await seedAttachment();
    expect(
      await resolveReadableBlob(
        getDb(),
        { isAdmin: true },
        userId,
        att("att-1"),
      ),
    ).toEqual({
      blobId: att("att-1"),
      type: "text/plain",
      size: 6,
      name: "report.txt",
      source: { r2Key: attachment.r2Key },
    });
    expect(
      await resolveReadableBlob(
        getDb(),
        { isAdmin: false, inboxes: ["someone-else@saasmail.test"] },
        userId,
        att("att-1"),
      ),
    ).toBeNull();
  });

  it("treats malformed and not-yet-served ids as not found", async () => {
    const { userId } = await createTestUser({ id: "aaa-uploader" });
    for (const id of ["", "U", "u!!", "A", "Pnope_text", "Rabc", "X1"]) {
      expect(
        await resolveReadableBlob(getDb(), { isAdmin: true }, userId, id),
      ).toBeNull();
    }
  });

  it("reads bytes from R2 or from an inline source", async () => {
    const { userId } = await createTestUser({ id: "aaa-uploader" });
    const r2Key = await seedUpload(userId, "up-2", "bytes");
    const bindings = env as unknown as CloudflareBindings;
    const fromR2 = await readBlobBytes(bindings, {
      blobId: upl("up-2"),
      type: "text/plain",
      size: 5,
      name: null,
      source: { r2Key },
    });
    expect(new TextDecoder().decode(fromR2!)).toBe("bytes");
    const inline = await readBlobBytes(bindings, {
      blobId: "Pany_text",
      type: "text/plain",
      size: 2,
      name: null,
      source: { bytes: new TextEncoder().encode("hi") },
    });
    expect(new TextDecoder().decode(inline!)).toBe("hi");
    expect(
      await readBlobBytes(bindings, {
        blobId: upl("gone"),
        type: "text/plain",
        size: 1,
        name: null,
        source: { r2Key: "jmap-uploads/nobody/gone" },
      }),
    ).toBeNull();
  });
});

describe("download headers", () => {
  it("uses the requested type unless it can't be a header value", () => {
    expect(downloadContentType("text/csv", "text/plain")).toBe("text/csv");
    expect(downloadContentType(undefined, "text/plain")).toBe("text/plain");
    expect(downloadContentType("", "text/plain")).toBe("text/plain");
    expect(downloadContentType("text/csv\r\nX-Evil: 1", "text/plain")).toBe(
      "text/plain",
    );
    expect(downloadContentType("text/é", "text/plain")).toBe("text/plain");
  });

  it("uses the requested name, sanitised, else the blob's own", () => {
    expect(downloadFilename("renamed.txt", "report.txt")).toBe("renamed.txt");
    expect(downloadFilename(undefined, "report.txt")).toBe("report.txt");
    expect(downloadFilename("", null)).toBe("download");
    expect(downloadFilename('a"b.txt', null)).toBe("a_b.txt");
    expect(downloadFilename("../../etc/passwd", null)).toBe("etc_passwd");
  });
});

describe("GET /jmap/download", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("serves uploads to their owner and 404s everyone else", async () => {
    const owner = await createTestUser({
      id: "aaa-uploader",
      email: "uploader@example.com",
    });
    const other = await createTestUser({
      id: "bbb-reader",
      email: "reader@example.com",
    });
    await seedUpload(owner.userId, "up-3", "secret");

    const mine = await authFetch(
      `/jmap/download/${acct(owner.userId)}/${upl("up-3")}/note.txt?type=text/plain`,
      { apiKey: owner.apiKey },
    );
    expect(mine.status).toBe(200);
    expect(await mine.text()).toBe("secret");

    const theirs = await authFetch(
      `/jmap/download/${acct(other.userId)}/${upl("up-3")}/note.txt?type=text/plain`,
      { apiKey: other.apiKey },
    );
    expect(theirs.status).toBe(404);
  });

  it("serves a zero-byte upload back empty", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "aaa-uploader",
      email: "uploader@example.com",
    });
    await seedUpload(userId, "up-empty", "");
    const download = await authFetch(
      `/jmap/download/${acct(userId)}/${upl("up-empty")}/empty.txt?type=text/plain`,
      { apiKey },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Length")).toBe("0");
    expect(await download.text()).toBe("");
  });

  it("honours the name and type URL variables (RFC 8620 §6.2)", async () => {
    const { userId, apiKey } = await createTestUser({ id: "aaa-uploader" });
    await seedAttachment();

    const renamed = await authFetch(
      `/jmap/download/${acct(userId)}/${att("att-1")}/renamed.csv?type=text/csv`,
      { apiKey },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.headers.get("Content-Type")).toBe("text/csv");
    expect(renamed.headers.get("Content-Disposition")).toContain(
      'filename="renamed.csv"',
    );
    expect(renamed.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(renamed.headers.get("Cache-Control")).toBe(
      "private, immutable, max-age=31536000",
    );
    expect(renamed.headers.get("Content-Length")).toBe("6");

    const untyped = await authFetch(
      `/jmap/download/${acct(userId)}/${att("att-1")}/r.txt`,
      { apiKey },
    );
    expect(untyped.headers.get("Content-Type")).toBe("text/plain");

    const injected = await authFetch(
      `/jmap/download/${acct(userId)}/${att("att-1")}/r.txt?type=text/csv%0D%0AX-Evil:1`,
      { apiKey },
    );
    expect(injected.status).toBe(200);
    expect(injected.headers.get("Content-Type")).toBe("text/plain");
    expect(injected.headers.get("X-Evil")).toBeNull();
  });

  it("404s malformed and body-part blob ids", async () => {
    const { userId, apiKey } = await createTestUser({ id: "aaa-uploader" });
    for (const blobId of ["U", "u!!", "Pnope_text"]) {
      const response = await authFetch(
        `/jmap/download/${acct(userId)}/${blobId}/x.txt`,
        { apiKey },
      );
      expect(response.status).toBe(404);
    }
  });
});
