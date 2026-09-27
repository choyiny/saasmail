import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyMigrations, cleanDb } from "./helpers";

describe("PR 6 columns", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  async function columns(table: string): Promise<string[]> {
    const { results } = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('${table}')`,
    ).all<{ name: string }>();
    return results.map((row) => row.name);
  }

  it("adds the alias, exclusion and frozen-From columns", async () => {
    expect(await columns("sent_emails")).toEqual(
      expect.arrayContaining(["jmap_email_id", "jmap_received_at"]),
    );
    expect(await columns("jmap_changes")).toContain("exclude_user_id");
    expect(await columns("jmap_drafts")).toContain("alias_delete");
    expect(await columns("jmap_submissions")).toContain("from_header");
  });

  it("allows one Sent row per aliased draft id, and any number of nulls", async () => {
    const insert = (id: string, alias: string | null) =>
      env.DB.prepare(
        `INSERT INTO sent_emails (id, from_address, to_address, subject, status, sent_at, created_at, jmap_email_id)
         VALUES (?, 'me@saasmail.test', 'to@example.com', 's', 'sent', 1, 1, ?)`,
      )
        .bind(id, alias)
        .run();
    await insert("s1", null);
    await insert("s2", null);
    await insert("s3", "draft-1");
    await expect(insert("s4", "draft-1")).rejects.toThrow();
  });
});
