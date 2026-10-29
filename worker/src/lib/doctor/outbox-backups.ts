import { sql } from "drizzle-orm";
import { readBackupSettings } from "../backup/settings";
import { count, type Check } from "./types";

const HOUR = 60 * 60;

export const outboxChecks: Check[] = [
  {
    id: "outbox.stuck",
    group: "outbox",
    mandatory: false,
    async run({ db, now }) {
      // One query per state, each through outbox_status_retry_idx (status first).
      const pending = await db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM outbox_emails WHERE status = 'pending' AND next_retry_at < ${now - HOUR}`,
      );
      const failed = await db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM outbox_emails WHERE status = 'failed' AND updated_at > ${now - 7 * 24 * HOUR}`,
      );
      const bookkeeping = await db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM outbox_emails WHERE status = 'bookkeeping_pending' AND updated_at < ${now - HOUR}`,
      );
      const parts = [
        count(pending) > 0 &&
          `${count(pending)} pending past their retry time by over an hour`,
        count(failed) > 0 && `${count(failed)} failed in the last 7 days`,
        count(bookkeeping) > 0 &&
          `${count(bookkeeping)} accepted but not recorded for over an hour`,
      ].filter(Boolean);
      return parts.length > 0
        ? {
            status: "warn",
            summary: `Outbox: ${parts.join("; ")}.`,
            hint: "Open the Outbox tab: retry or delete failed sends; pending ones mean the cron is not draining it.",
          }
        : {
            status: "pass",
            summary: "The outbox has no stuck or failed send.",
          };
    },
  },
];

export const backupChecks: Check[] = [
  {
    id: "backups.recent",
    group: "backups",
    mandatory: false,
    async run({ db, now }) {
      const settings = await readBackupSettings(db);
      if (!settings.enabled) {
        return {
          status: "info",
          summary: "Scheduled backups are off.",
          hint: "Turn them on in Settings → Data → Backups.",
        };
      }
      const recent = await db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM backup_runs WHERE status = 'completed' AND pruned_at IS NULL AND started_at > ${now - 26 * HOUR}`,
      );
      const stuck = await db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM backup_runs WHERE status = 'running' AND started_at < ${now - 6 * HOUR}`,
      );
      const last = await db.get<{ status: string; error: string | null }>(
        sql`SELECT status, error FROM backup_runs ORDER BY started_at DESC LIMIT 1`,
      );
      const problems: string[] = [];
      if (last?.status === "failed") {
        problems.push(
          `the last backup failed${last.error ? `: ${last.error}` : ""}`,
        );
      }
      if (count(stuck) > 0) {
        problems.push(`${count(stuck)} running for more than 6 hours`);
      }
      if (count(recent) === 0) {
        problems.push("no completed backup in the last 26 hours");
      }
      return problems.length > 0
        ? {
            status: "warn",
            summary: `Backups: ${problems.join("; ")}.`,
            hint: "See Settings → Data → Backups, or start one with “Back up now”.",
          }
        : {
            status: "pass",
            summary: "A backup completed in the last 26 hours.",
          };
    },
  },
];
