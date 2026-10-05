import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { asyncJobs } from "../db/async-jobs.schema";
import { contacts } from "../db/contacts.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { people } from "../db/people.schema";
import { parseCsv, readCsvHeader } from "../lib/parse-csv";
import {
  IMPORT_PAGE_SIZE,
  purgeFinishedImports,
  runListImportPage,
  sourceKey,
  stageCsv,
  stagedKey,
} from "../lib/list-import";

beforeAll(applyMigrations);
beforeEach(async () => {
  await cleanDb();
  // R2 is shared across tests in this worker; clear the import prefix.
  const listed = await env.R2.list({ prefix: "imports/" });
  for (const o of listed.objects) await env.R2.delete(o.key);
});

const LIST_ID = "list-1";

async function seedList() {
  const ts = Math.floor(Date.now() / 1000);
  await getDb().insert(lists).values({
    id: LIST_ID,
    name: "Weekly",
    description: null,
    fromAddress: "news@example.com",
    doubleOptIn: 0,
    confirmationTemplateSlug: null,
    archivedAt: null,
    createdAt: ts,
    updatedAt: ts,
  });
}

async function startJob(csv: string, jobId = "job-1") {
  const ts = Math.floor(Date.now() / 1000);
  await env.R2.put(sourceKey(jobId), csv);
  await getDb()
    .insert(asyncJobs)
    .values({
      id: jobId,
      jobType: "list_import",
      refId: LIST_ID,
      status: "running",
      cursor: null,
      storageKey: sourceKey(jobId),
      totalRows: null,
      processedRows: 0,
      importedCount: 0,
      skippedCount: 0,
      errorSummary: null,
      createdAt: ts,
      updatedAt: ts,
    });
  return jobId;
}

async function job(jobId = "job-1") {
  const rows = await getDb()
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId));
  return rows[0];
}

/** Drive the coordinator to completion the way the queue would. */
async function runToCompletion(jobId = "job-1", maxPages = 200) {
  for (let i = 0; i < maxPages; i++) {
    await runListImportPage(
      getDb(),
      env as unknown as CloudflareBindings,
      jobId,
    );
    const j = await job(jobId);
    if (j.status !== "running") return j;
  }
  throw new Error("import did not finish within the page budget");
}

describe("parseCsv", () => {
  it("parses a simple file", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles CRLF and a trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a UTF-8 BOM so the first header still matches", () => {
    const rows = parseCsv("﻿email,name\na@b.com,A");
    expect(rows[0][0]).toBe("email");
    expect(readCsvHeader(rows[0])).toEqual({ email: 0, name: 1 });
  });

  /** The case that makes byte-offset resumption unsafe. */
  it("keeps a newline inside a quoted field", () => {
    expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([["a"], ['say "hi"']]);
  });

  it("keeps a comma inside a quoted field", () => {
    expect(parseCsv('a,b\n"x,y",z')).toEqual([
      ["a", "b"],
      ["x,y", "z"],
    ]);
  });

  it("preserves empty trailing cells", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("readCsvHeader", () => {
  it("matches case-insensitively and trims", () => {
    expect(readCsvHeader([" Email ", "NAME"])).toEqual({ email: 0, name: 1 });
  });

  it("returns null without an email column", () => {
    expect(readCsvHeader(["first", "last"])).toBeNull();
  });

  it("allows a missing name column", () => {
    expect(readCsvHeader(["email"])).toEqual({ email: 0, name: null });
  });
});

describe("stageCsv", () => {
  it("normalizes addresses and keeps names", () => {
    const { rows } = stageCsv("email,name\n A@B.com ,Alice\n");
    expect(rows).toEqual([{ row: 2, email: "a@b.com", name: "Alice" }]);
  });

  it("skips invalid addresses with a row number an operator can find", () => {
    const { rows, skipped } = stageCsv("email\na@b.com\nnope\n");
    expect(rows).toHaveLength(1);
    // Row 3 = the third line of the file, counting the header.
    expect(skipped).toEqual([{ row: 3, reason: "invalid_email" }]);
  });

  it("keeps the first occurrence of a duplicate and reports the rest", () => {
    const { rows, skipped } = stageCsv(
      "email,name\na@b.com,First\na@b.com,Second\n",
    );
    expect(rows).toEqual([{ row: 2, email: "a@b.com", name: "First" }]);
    expect(skipped).toEqual([{ row: 3, reason: "duplicate_in_file" }]);
  });

  it("ignores blank trailing lines rather than reporting them as errors", () => {
    const { rows, skipped } = stageCsv("email\na@b.com\n\n");
    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it("throws when there is no email column", () => {
    expect(() => stageCsv("first,last\nA,B")).toThrow(/email/);
  });
});

describe("runListImportPage", () => {
  it("imports a small file and completes", async () => {
    await seedList();
    await startJob("email,name\na@example.com,A\nb@example.com,B\n");

    const finished = await runToCompletion();
    expect(finished.status).toBe("completed");
    expect(finished.importedCount).toBe(2);
    expect(finished.totalRows).toBe(2);

    const members = await getDb().select().from(listMembers);
    expect(members).toHaveLength(2);
    expect(members[0].source).toBe("import");
    expect(members[0].consentSource).toBe("import");
    expect(members[0].status).toBe("subscribed");
    expect(members[0].importJobId).toBe("job-1");

    // Import must not manufacture correspondents.
    expect(await getDb().select().from(people)).toHaveLength(0);
  });

  it("pages through a file larger than one page", async () => {
    await seedList();
    const n = IMPORT_PAGE_SIZE * 2 + 25;
    const lines = ["email"];
    for (let i = 0; i < n; i++) lines.push(`u${i}@example.com`);
    await startJob(lines.join("\n"));

    // One page is not enough...
    await runListImportPage(
      getDb(),
      env as unknown as CloudflareBindings,
      "job-1",
    );
    const afterFirst = await job();
    expect(afterFirst.status).toBe("running");
    expect(afterFirst.processedRows).toBe(IMPORT_PAGE_SIZE);

    const finished = await runToCompletion();
    expect(finished.status).toBe("completed");
    expect(finished.importedCount).toBe(n);
    expect(await getDb().select().from(listMembers)).toHaveLength(n);
  });

  /**
   * The reason rows are staged up front. If resumption used a raw byte offset,
   * a page boundary landing inside this quoted field would split it and corrupt
   * every later row.
   */
  it("keeps a multiline quoted field intact across a page boundary", async () => {
    await seedList();
    const lines = ["email,name"];
    for (let i = 0; i < IMPORT_PAGE_SIZE - 1; i++) {
      lines.push(`u${i}@example.com,U${i}`);
    }
    // Lands exactly on the boundary between page 1 and page 2.
    lines.push('boundary@example.com,"Multi\nLine Name"');
    for (let i = 0; i < 10; i++) lines.push(`v${i}@example.com,V${i}`);
    await startJob(lines.join("\n"));

    const finished = await runToCompletion();
    expect(finished.status).toBe("completed");
    expect(finished.importedCount).toBe(IMPORT_PAGE_SIZE + 10);

    const boundary = await getDb()
      .select()
      .from(contacts)
      .where(eq(contacts.email, "boundary@example.com"));
    expect(boundary).toHaveLength(1);
    // The control character is stripped at ingestion, but both words survive.
    expect(boundary[0].name).toBe("Multi Line Name");
  });

  it("stops after a cancel and keeps what it already imported", async () => {
    await seedList();
    const lines = ["email"];
    for (let i = 0; i < IMPORT_PAGE_SIZE * 3; i++) {
      lines.push(`u${i}@example.com`);
    }
    await startJob(lines.join("\n"));

    await runListImportPage(
      getDb(),
      env as unknown as CloudflareBindings,
      "job-1",
    );
    await getDb()
      .update(asyncJobs)
      .set({ status: "cancelled" })
      .where(eq(asyncJobs.id, "job-1"));

    // A further invocation is a no-op rather than an error.
    await runListImportPage(
      getDb(),
      env as unknown as CloudflareBindings,
      "job-1",
    );

    const j = await job();
    expect(j.status).toBe("cancelled");
    // Rows already written stay: they may already have been mailed.
    expect(await getDb().select().from(listMembers)).toHaveLength(
      IMPORT_PAGE_SIZE,
    );
  });

  it("does not resurrect an unsubscribed member", async () => {
    await seedList();
    const ts = Math.floor(Date.now() / 1000);
    await getDb().insert(contacts).values({
      id: "c-1",
      email: "gone@example.com",
      name: null,
      personId: null,
      createdAt: ts,
      updatedAt: ts,
    });
    await getDb().insert(listMembers).values({
      id: "m-1",
      listId: LIST_ID,
      contactId: "c-1",
      email: "gone@example.com",
      status: "unsubscribed",
      source: "form",
      formId: null,
      submittedIp: null,
      consentSource: "form",
      consentAt: ts,
      importJobId: null,
      subscribedAt: ts,
      confirmedAt: null,
      unsubscribedAt: ts,
      unsubscribeReason: null,
      createdAt: ts,
    });

    await startJob("email\ngone@example.com\n");
    const finished = await runToCompletion();

    expect(finished.status).toBe("completed");
    expect(finished.importedCount).toBe(0);
    const members = await getDb().select().from(listMembers);
    expect(members).toHaveLength(1);
    // An import is not consent to re-subscribe someone who opted out.
    expect(members[0].status).toBe("unsubscribed");
  });

  it("records skip reasons on the job, capped but counted in full", async () => {
    await seedList();
    const lines = ["email"];
    for (let i = 0; i < 60; i++) lines.push("not-an-email");
    lines.push("ok@example.com");
    await startJob(lines.join("\n"));

    const finished = await runToCompletion();
    expect(finished.importedCount).toBe(1);
    expect(finished.skippedCount).toBe(60);
    // The list is capped so the row does not grow without bound...
    const errors = JSON.parse(finished.errorSummary!);
    expect(errors).toHaveLength(50);
    // ...but the count is exact.
    expect(errors[0]).toEqual({ row: 2, reason: "invalid_email" });
  });

  it("fails the job when the uploaded object is gone", async () => {
    await seedList();
    await startJob("email\na@example.com\n");
    await env.R2.delete(sourceKey("job-1"));

    await runListImportPage(
      getDb(),
      env as unknown as CloudflareBindings,
      "job-1",
    );
    const j = await job();
    expect(j.status).toBe("failed");
    expect(j.errorSummary).toContain("uploaded_file_missing");
  });

  it("fails the job when the CSV has no email column", async () => {
    await seedList();
    await startJob("first,last\nA,B\n");
    await runListImportPage(
      getDb(),
      env as unknown as CloudflareBindings,
      "job-1",
    );
    expect((await job()).status).toBe("failed");
  });

  it("throws for an unknown job so the queue retries it", async () => {
    await expect(
      runListImportPage(
        getDb(),
        env as unknown as CloudflareBindings,
        "no-such-job",
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe("purgeFinishedImports", () => {
  it("deletes the R2 objects of jobs finished past the retention window", async () => {
    await seedList();
    await startJob("email\na@example.com\n");
    await runToCompletion();

    const now = Math.floor(Date.now() / 1000);
    // Age the job past the window.
    await getDb()
      .update(asyncJobs)
      .set({ updatedAt: now - 25 * 3600 })
      .where(eq(asyncJobs.id, "job-1"));

    await purgeFinishedImports(
      getDb(),
      env as unknown as CloudflareBindings,
      now,
    );

    expect(await env.R2.get(sourceKey("job-1"))).toBeNull();
    expect(await env.R2.get(stagedKey("job-1"))).toBeNull();
    // The key is nulled so later ticks do not re-sweep the same job.
    expect((await job()).storageKey).toBeNull();
  });

  it("leaves a recently finished job alone", async () => {
    await seedList();
    await startJob("email\na@example.com\n");
    await runToCompletion();

    await purgeFinishedImports(
      getDb(),
      env as unknown as CloudflareBindings,
      Math.floor(Date.now() / 1000),
    );
    expect(await env.R2.get(sourceKey("job-1"))).not.toBeNull();
  });

  it("never touches a running job's file", async () => {
    await seedList();
    const lines = ["email"];
    for (let i = 0; i < IMPORT_PAGE_SIZE * 2; i++) {
      lines.push(`u${i}@example.com`);
    }
    await startJob(lines.join("\n"));
    await runListImportPage(
      getDb(),
      env as unknown as CloudflareBindings,
      "job-1",
    );

    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .update(asyncJobs)
      .set({ updatedAt: now - 25 * 3600 })
      .where(eq(asyncJobs.id, "job-1"));

    await purgeFinishedImports(
      getDb(),
      env as unknown as CloudflareBindings,
      now,
    );
    expect(await env.R2.get(stagedKey("job-1"))).not.toBeNull();
  });
});
