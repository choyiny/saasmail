// docs/specs/SPEC-audit-log.md §2: the actor context and the recorder.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents } from "../db/audit-events.schema";
import {
  currentAuditActor,
  runWithAudit,
  systemActor,
  type AuditActor,
} from "../lib/audit/context";
import { AUDIT_ACTIONS } from "../lib/audit/events";
import {
  AUDIT_DETAILS_MAX_BYTES,
  bulkDetails,
  recordAudit,
  serializeDetails,
} from "../lib/audit/record";
import { applyMigrations, cleanDb, getDb } from "./helpers";

const JANE: AuditActor = {
  actorType: "user",
  actorUserId: "user-jane",
  actorLabel: "jane@acme.com",
  channel: "web",
  ip: "203.0.113.7",
  userAgent: "Mozilla/5.0",
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("audit actor context", () => {
  it("is the system when no boundary set an actor", () => {
    expect(currentAuditActor()).toEqual(systemActor("cron"));
  });

  it("is the actor of the enclosing run, across awaits", async () => {
    await runWithAudit(JANE, async () => {
      await tick();
      expect(currentAuditActor()).toBe(JANE);
    });
    expect(currentAuditActor().actorType).toBe("system");
  });

  it("does not leak between two interleaved runs", async () => {
    const rule: AuditActor = {
      actorType: "rule",
      actorUserId: null,
      actorLabel: "Invoices",
      channel: "rule",
      ruleId: "rule-1",
    };
    const seen: string[] = [];
    await Promise.all([
      runWithAudit(JANE, async () => {
        await tick();
        seen.push(`a:${currentAuditActor().actorLabel}`);
        await tick();
        seen.push(`a:${currentAuditActor().actorLabel}`);
      }),
      runWithAudit(rule, async () => {
        seen.push(`b:${currentAuditActor().actorLabel}`);
        await tick();
        await tick();
        seen.push(`b:${currentAuditActor().actorLabel}`);
      }),
    ]);
    expect(seen.sort()).toEqual([
      "a:jane@acme.com",
      "a:jane@acme.com",
      "b:Invoices",
      "b:Invoices",
    ]);
  });

  it("lets an inner run name a more specific actor", async () => {
    await runWithAudit(systemActor("inbound"), async () => {
      expect(currentAuditActor().channel).toBe("inbound");
      await runWithAudit(JANE, async () => {
        expect(currentAuditActor().actorLabel).toBe("jane@acme.com");
      });
      expect(currentAuditActor().channel).toBe("inbound");
    });
  });
});

describe("recordAudit", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("writes the event with the current actor", async () => {
    await runWithAudit(JANE, () =>
      recordAudit(getDb(), {
        action: AUDIT_ACTIONS.mailArchived,
        targetType: "message",
        targetId: "received:e1",
        inbox: "Support@Acme.com",
        summary: "Archived 1 message in support@acme.com",
        details: { count: 1 },
      }),
    );

    const rows = await getDb().select().from(auditEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "user",
      actorUserId: "user-jane",
      actorLabel: "jane@acme.com",
      channel: "web",
      action: "mail.archived",
      targetType: "message",
      targetId: "received:e1",
      inbox: "support@acme.com",
      summary: "Archived 1 message in support@acme.com",
      details: '{"count":1}',
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0",
    });
    expect(rows[0].id).toBeTruthy();
    expect(Math.abs(rows[0].at - Date.now() / 1000)).toBeLessThan(5);
  });

  it("records the system when nothing set an actor", async () => {
    await recordAudit(getDb(), {
      action: AUDIT_ACTIONS.mailDeleted,
      summary: "Deleted 1 message",
    });
    const [row] = await getDb().select().from(auditEvents);
    expect(row).toMatchObject({
      actorType: "system",
      actorUserId: null,
      actorLabel: "system",
      targetType: null,
      targetId: null,
      inbox: null,
      details: null,
      ip: null,
      userAgent: null,
    });
  });

  it("cuts a long summary and a long user agent", async () => {
    await runWithAudit({ ...JANE, userAgent: "u".repeat(500) }, () =>
      recordAudit(getDb(), {
        action: AUDIT_ACTIONS.mailSent,
        summary: "s".repeat(1000),
      }),
    );
    const [row] = await getDb().select().from(auditEvents);
    expect(row.summary).toHaveLength(300);
    expect(row.summary.endsWith("…")).toBe(true);
    expect(row.userAgent).toHaveLength(200);
  });

  it("keeps details within 4 KB", async () => {
    await recordAudit(getDb(), {
      action: AUDIT_ACTIONS.mailTrashed,
      summary: "Trashed many messages",
      details: bulkDetails(
        Array.from({ length: 500 }, (_, i) => `received:${i}`),
        { blob: "x".repeat(20_000), note: "kept" },
      ),
    });
    const [row] = await getDb().select().from(auditEvents);
    expect(new TextEncoder().encode(row.details!).length).toBeLessThanOrEqual(
      AUDIT_DETAILS_MAX_BYTES,
    );
    const details = JSON.parse(row.details!);
    expect(details.count).toBe(500);
    expect(details.refs).toHaveLength(20);
    expect(details.note).toBe("kept");
  });

  it("never throws when the write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {
      insert() {
        throw new Error("D1 is down");
      },
    };
    await expect(
      recordAudit(broken as never, {
        action: AUDIT_ACTIONS.mailSent,
        summary: "Sent",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("serializeDetails", () => {
  it("is null for nothing", () => {
    expect(serializeDetails(null)).toBeNull();
    expect(serializeDetails({})).toBeNull();
  });

  it("drops the largest keys and says so when cutting is not enough", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`k${i}`, "v".repeat(400)]),
    );
    const json = serializeDetails({ ...wide, id: "x1" })!;
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(
      AUDIT_DETAILS_MAX_BYTES,
    );
    const parsed = JSON.parse(json);
    expect(parsed.truncated).toBe(true);
    expect(parsed.id).toBe("x1");
  });
});
