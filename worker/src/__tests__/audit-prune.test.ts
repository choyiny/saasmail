// docs/archive/SPEC-audit-log.md §5: retention.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  AUDIT_PRUNE_BATCH,
  AUDIT_PRUNE_MAX_BATCHES,
  auditRetentionDays,
  pruneAuditEvents,
} from "../lib/audit/prune";
import { applyMigrations, cleanDb, getDb } from "./helpers";

const DAY = 24 * 60 * 60;
const NOW = 2_000_000_000;

/** `count` events, all at `at`, with ids `<prefix>-1..count`. */
async function seed(prefix: string, count: number, at: number) {
  await getDb().run(sql`
    INSERT INTO audit_events
      (id, at, actor_type, actor_label, channel, action, summary)
    WITH RECURSIVE n(i) AS (
      SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}
    )
    SELECT ${prefix} || '-' || i, ${at}, 'system', 'system', 'cron',
      'mail.sent', 'Sent'
    FROM n
  `);
}

async function count(prefix: string): Promise<number> {
  const rows = await getDb().all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM audit_events WHERE id LIKE ${`${prefix}-%`}`,
  );
  return Number(rows[0]?.n ?? 0);
}

describe("auditRetentionDays", () => {
  it("defaults to 180 days", () => {
    expect(auditRetentionDays(undefined)).toBe(180);
    expect(auditRetentionDays({} as never)).toBe(180);
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: "soon" } as never)).toBe(
      180,
    );
  });

  it("takes the configured value, but never under 30 days", () => {
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: "365" } as never)).toBe(
      365,
    );
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: "7" } as never)).toBe(30);
  });
});

describe("pruneAuditEvents", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("deletes only events older than the retention period", async () => {
    await seed("old", 3, NOW - 181 * DAY);
    await seed("edge", 2, NOW - 180 * DAY);
    await seed("new", 4, NOW - DAY);

    expect(await pruneAuditEvents(getDb(), NOW)).toBe(3);
    expect(await count("old")).toBe(0);
    // Exactly 180 days old is not yet older than the period.
    expect(await count("edge")).toBe(2);
    expect(await count("new")).toBe(4);
  });

  it("honours a shorter configured period", async () => {
    await seed("old", 3, NOW - 40 * DAY);
    expect(await pruneAuditEvents(getDb(), NOW, 30)).toBe(3);
  });

  it("deletes in batches up to a bound per pass, oldest first", async () => {
    const bound = AUDIT_PRUNE_BATCH * AUDIT_PRUNE_MAX_BATCHES;
    await seed("oldest", 5, NOW - 300 * DAY);
    await seed("old", bound, NOW - 200 * DAY);

    // One pass takes as many batches as it is allowed and no more.
    expect(await pruneAuditEvents(getDb(), NOW)).toBe(bound);
    expect(await count("oldest")).toBe(0);
    expect(await count("old")).toBe(5);

    expect(await pruneAuditEvents(getDb(), NOW)).toBe(5);
    expect(await pruneAuditEvents(getDb(), NOW)).toBe(0);
  });
});
