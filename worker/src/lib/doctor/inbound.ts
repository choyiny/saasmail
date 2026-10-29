import { sql } from "drizzle-orm";
import type { Check } from "./types";

const QUIET_AFTER = 30 * 24 * 60 * 60;

export const inboundChecks: Check[] = [
  {
    id: "inbound.recent",
    group: "inbound",
    mandatory: false,
    async run({ db, now }) {
      // Per inbox through emails_recipient_received_idx, not a table scan.
      const row = await db.get<{ inboxes: number; last: number | null }>(
        sql`SELECT COUNT(*) AS inboxes,
          MAX((SELECT MAX(e.received_at) FROM emails e WHERE e.recipient = s.email)) AS last
          FROM sender_identities s`,
      );
      const inboxes = Number(row?.inboxes ?? 0);
      if (inboxes === 0) {
        return { status: "info", summary: "No inbox is set up yet." };
      }
      const last = row?.last == null ? null : Number(row.last);
      if (last === null || now - last > QUIET_AFTER) {
        return {
          status: "info",
          summary:
            "No mail received in 30 days. A quiet inbox looks the same as broken routing.",
          hint: "Run `yarn doctor` with CLOUDFLARE_API_TOKEN to check the Email Routing rules.",
        };
      }
      return {
        status: "pass",
        summary: `Mail received ${Math.floor((now - last) / 86_400)} day(s) ago.`,
      };
    },
  },
];
