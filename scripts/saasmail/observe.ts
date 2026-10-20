import type { CatchAll, Cloudflare, Queue } from "./cloudflare.ts";
import type { ResourceNames } from "./names.ts";
import type { Provider } from "./state.ts";

export const R2_MARKER_KEY = ".saasmail/ownership.json";

const TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' " +
  "AND name NOT IN ('sqlite_sequence','d1_migrations')";
const INSTALL_ROW_SQL =
  "SELECT installation_id, ownership_nonce FROM install_state LIMIT 1";

export interface InstallRow {
  installation_id: string;
  ownership_nonce: string;
}

/** The mail inputs observe needs: which zones to read routing and sending for. */
export interface MailInputs {
  inboundDomains: string[];
  provider: Provider;
  sendDomains: string[];
}

export interface RoutingObserved {
  /** Email Routing on the zone (false when the settings answer 404). */
  enabled: boolean;
  status: string | null;
  /** The zone's catch-all rule; null when it answers 404. */
  catchAll: CatchAll | null;
}

/** What Cloudflare holds right now, as far as the plan needs to know. */
export interface Observed {
  /** `vars` holds plain-text vars; null when the worker does not exist. */
  worker: { exists: boolean; vars: Record<string, string> | null };
  d1: { uuid: string; name: string }[];
  /** User tables per D1 uuid, only for databases named `names.d1`. */
  d1Tables: Record<string, string[]>;
  /** The `install_state` row per D1 uuid (null: no table or no row), only for `names.d1`. */
  d1InstallRow: Record<string, InstallRow | null>;
  r2: string[];
  /** Raw ownership marker body per bucket (null: no marker), only for our buckets that exist. */
  r2Markers: Record<string, string | null>;
  /** Whether the bucket holds no object, only for our buckets that exist without a marker. */
  r2Empty: Record<string, boolean>;
  queues: Queue[];
  workflows: { name: string; scriptName: string }[];
  /** Zone id per inbound/send domain; null when no zone in the account holds it. */
  zones: Record<string, string | null>;
  /** Per inbound domain whose zone was found. */
  routing: Record<string, RoutingObserved>;
  /** Per send domain whose zone was found (provider `cloudflare` only). */
  sending: Record<string, { present: boolean }>;
}

/** Read-only: every list call runs in parallel, then the per-resource lookups for our names. */
export async function observe(
  cf: Cloudflare,
  accountId: string,
  names: ResourceNames,
  mail: MailInputs,
): Promise<Observed> {
  const sendDomains = mail.provider === "cloudflare" ? mail.sendDomains : [];
  const domains = [...new Set([...mail.inboundDomains, ...sendDomains])];

  const [vars, d1, r2, queues, workflows, zoneList] = await Promise.all([
    cf.workerVars(accountId, names.worker),
    cf.listD1(accountId),
    cf.listR2(accountId),
    cf.listQueues(accountId),
    cf.listWorkflows(accountId),
    Promise.all(
      domains.map(
        async (d) =>
          [d, (await cf.findZone(accountId, d))?.id ?? null] as const,
      ),
    ),
  ]);
  const zones: Observed["zones"] = Object.fromEntries(zoneList);

  const ours = d1.filter((d) => d.name === names.d1);
  const buckets = [names.attachments].filter((b) => r2.includes(b));

  const [d1Reads, markers, routingReads, sendingReads] = await Promise.all([
    Promise.all(
      ours.map(async (db) => {
        const rows = await cf.queryD1(accountId, db.uuid, TABLES_SQL);
        const tables = rows.map((r) => String(r.name));
        let row: InstallRow | null = null;
        if (tables.includes("install_state")) {
          const found = await cf.queryD1(accountId, db.uuid, INSTALL_ROW_SQL);
          if (found[0]) {
            row = {
              installation_id: String(found[0].installation_id),
              ownership_nonce: String(found[0].ownership_nonce),
            };
          }
        }
        return { uuid: db.uuid, tables, row };
      }),
    ),
    Promise.all(
      buckets.map(
        async (b) =>
          [b, await cf.getR2Object(accountId, b, R2_MARKER_KEY)] as const,
      ),
    ),
    Promise.all(
      mail.inboundDomains.flatMap((d) => {
        const zoneId = zones[d];
        if (!zoneId) return [];
        return [
          (async () => {
            const [settings, catchAll] = await Promise.all([
              cf.emailRouting(zoneId),
              cf.catchAll(zoneId),
            ]);
            const r: RoutingObserved = {
              enabled: settings?.enabled ?? false,
              status: settings?.status ?? null,
              catchAll,
            };
            return [d, r] as const;
          })(),
        ];
      }),
    ),
    Promise.all(
      sendDomains.flatMap((d) => {
        const zoneId = zones[d];
        if (!zoneId) return [];
        return [
          (async () => {
            const subs = await cf.listSendingSubdomains(zoneId);
            const present = subs.some(
              (s) => s.name.toLowerCase() === d.toLowerCase(),
            );
            return [d, { present }] as const;
          })(),
        ];
      }),
    ),
  ]);

  // One cheap list per unmarked bucket of ours: an empty one may be ours from an interrupted run.
  const unmarked = markers.filter(([, m]) => m === null).map(([b]) => b);
  const empties = await Promise.all(
    unmarked.map(async (b) => [b, await cf.r2IsEmpty(accountId, b)] as const),
  );

  const d1Tables: Observed["d1Tables"] = {};
  const d1InstallRow: Observed["d1InstallRow"] = {};
  for (const r of d1Reads) {
    d1Tables[r.uuid] = r.tables;
    d1InstallRow[r.uuid] = r.row;
  }

  return {
    worker: { exists: vars !== null, vars },
    d1,
    d1Tables,
    d1InstallRow,
    r2,
    r2Markers: Object.fromEntries(markers),
    r2Empty: Object.fromEntries(empties),
    queues,
    workflows,
    zones,
    routing: Object.fromEntries(routingReads),
    sending: Object.fromEntries(sendingReads),
  };
}
