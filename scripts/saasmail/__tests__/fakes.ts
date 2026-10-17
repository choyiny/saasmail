import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CatchAll,
  Cloudflare,
  EmailRoutingSettings,
  Queue,
  SendingDnsRecord,
  SendingSubdomain,
  WorkerBinding,
} from "../cloudflare.ts";
import { plainTextVars } from "../cloudflare.ts";
import type { RunOptions, RunResult, Runner } from "../runner.ts";

type Handler = (args: string[]) => RunResult | Promise<RunResult>;

/**
 * A Runner driven by a script keyed by `cmd` or `cmd arg0` (the more specific key wins).
 * Unscripted commands fail loudly.
 */
export function fakeRunner(script: Record<string, Handler>): Runner & {
  calls: Array<{ cmd: string; args: string[]; opts?: RunOptions }>;
} {
  const calls: Array<{ cmd: string; args: string[]; opts?: RunOptions }> = [];
  return {
    calls,
    async run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      const handler = script[`${cmd} ${args[0] ?? ""}`.trim()] ?? script[cmd];
      if (!handler)
        throw new Error(`fakeRunner: unscripted ${cmd} ${args.join(" ")}`);
      return handler(args);
    },
  };
}

export interface FakeCloudflareSeed {
  accounts?: { id: string; name: string }[];
  d1?: { uuid: string; name: string }[];
  /** bucket name -> objects (key -> body) */
  r2?: Record<string, Record<string, string>>;
  workflows?: { name: string; scriptName: string }[];
  /** script name -> plain_text vars; absent script = 404 */
  workerVars?: Record<string, Record<string, string>>;
  /** script name -> every binding of its settings (vars come from its plain_text ones); absent = 404 */
  workers?: Record<string, WorkerBinding[]>;
  zones?: { id: string; name: string; status: string }[];
  subdomain?: string | null;
  workerDomains?: { hostname: string; service: string }[];
  /** zone id -> DNS records */
  dnsRecords?: Record<
    string,
    { name: string; type: string; content: string; priority?: number }[]
  >;
  /** zone id -> Workers routes */
  routes?: Record<string, { pattern: string; script: string | null }[]>;
  queues?: Queue[];
  /** zone id -> Email Routing settings; absent zone = 404 (null) */
  routing?: Record<string, EmailRoutingSettings>;
  /** zone id -> catch-all rule; absent zone = 404 (null) */
  catchAll?: Record<string, CatchAll>;
  /** zone id -> Email Sending subdomains */
  sending?: Record<string, SendingSubdomain[]>;
  /** sending subdomain id (or name) -> the DNS records it needs */
  sendingDns?: Record<string, SendingDnsRecord[]>;
  /**
   * After `enableEmailRoutingDns`, the status stays "unconfigured" until this many `emailRouting`
   * reads (the last of them answers "ready"); `Infinity` never gets ready. Unset: ready at once.
   */
  routingReadyAfter?: number;
  /**
   * D1 uuid -> names in its `d1_migrations` table, answered to `SELECT name FROM d1_migrations`;
   * a uuid without an entry has no such table (the query fails like D1's).
   */
  d1Migrations?: Record<string, string[]>;
  /** D1 uuid -> its other table names, answered to `SELECT name FROM sqlite_master …`. */
  d1Tables?: Record<string, string[]>;
}

export type FakeCloudflare = Cloudflare & {
  calls: Array<{ method: string; args: unknown[] }>;
  /** Make the next call to `method` reject with `error`. */
  failNext(method: keyof Cloudflare, error: Error): void;
  /** Mutable state, for assertions. */
  state: {
    d1: { uuid: string; name: string; queries: string[] }[];
    r2: Record<string, Record<string, string>>;
    queues: Queue[];
    routing: Record<string, EmailRoutingSettings>;
    catchAll: Record<string, CatchAll>;
    sending: Record<string, SendingSubdomain[]>;
  };
};

/** In-memory Cloudflare REST fake with seedable state, a call log and one-shot failures. */
export function fakeCloudflare(seed: FakeCloudflareSeed = {}): FakeCloudflare {
  const calls: FakeCloudflare["calls"] = [];
  const failures = new Map<string, Error[]>();
  const state: FakeCloudflare["state"] = {
    d1: (seed.d1 ?? []).map((d) => ({ ...d, queries: [] })),
    r2: structuredClone(seed.r2 ?? {}),
    queues: structuredClone(seed.queues ?? []),
    routing: structuredClone(seed.routing ?? {}),
    catchAll: structuredClone(seed.catchAll ?? {}),
    sending: structuredClone(seed.sending ?? {}),
  };
  let nextId = 1;
  /** zone id -> `emailRouting` reads left before the status turns "ready". */
  const pendingReady = new Map<string, number>();

  async function enter(method: keyof Cloudflare, args: unknown[]) {
    calls.push({ method, args });
    const err = failures.get(method)?.shift();
    if (err) throw err;
  }

  const fake: FakeCloudflare = {
    calls,
    state,
    failNext(method, error) {
      failures.set(method, [...(failures.get(method) ?? []), error]);
    },
    async listAccounts() {
      await enter("listAccounts", []);
      return seed.accounts ?? [];
    },
    async workersSubdomain(a) {
      await enter("workersSubdomain", [a]);
      return seed.subdomain ?? null;
    },
    async findZone(a, hostname) {
      await enter("findZone", [a, hostname]);
      const labels = hostname.split(".");
      for (let i = 0; i <= labels.length - 2; i++) {
        const name = labels.slice(i).join(".");
        const z = (seed.zones ?? []).find((x) => x.name === name);
        if (z) return z;
      }
      return null;
    },
    async workerDomains(a) {
      await enter("workerDomains", [a]);
      return seed.workerDomains ?? [];
    },
    async dnsRecords(zoneId, name) {
      await enter("dnsRecords", [zoneId, name]);
      return (seed.dnsRecords?.[zoneId] ?? [])
        .filter((r) => r.name.toLowerCase() === name.toLowerCase())
        .map(({ type, content }) => ({ type, content }));
    },
    async workerRoutes(zoneId) {
      await enter("workerRoutes", [zoneId]);
      return seed.routes?.[zoneId] ?? [];
    },
    async r2IsEmpty(a, bucket) {
      await enter("r2IsEmpty", [a, bucket]);
      const b = state.r2[bucket];
      if (!b) throw new Error(`fakeCloudflare: no bucket ${bucket}`);
      return Object.keys(b).length === 0;
    },
    async listD1(a) {
      await enter("listD1", [a]);
      return state.d1.map(({ uuid, name }) => ({ uuid, name }));
    },
    async createD1(a, name) {
      await enter("createD1", [a, name]);
      const uuid = `d1-${nextId++}`;
      state.d1.push({ uuid, name, queries: [] });
      return { uuid };
    },
    async queryD1(a, id, sql, params) {
      await enter("queryD1", [a, id, sql, params]);
      const db = state.d1.find((d) => d.uuid === id);
      if (!db) throw new Error(`fakeCloudflare: no D1 ${id}`);
      db.queries.push(sql);
      if (/^SELECT name FROM d1_migrations/.test(sql)) {
        const names = seed.d1Migrations?.[id];
        if (!names)
          throw new Error("no such table: d1_migrations: SQLITE_ERROR");
        return names.map((name) => ({ name }));
      }
      if (/^SELECT name FROM sqlite_master/.test(sql)) {
        return (seed.d1Tables?.[id] ?? []).map((name) => ({ name }));
      }
      return [];
    },
    async listR2(a) {
      await enter("listR2", [a]);
      return Object.keys(state.r2);
    },
    async createR2(a, name) {
      await enter("createR2", [a, name]);
      state.r2[name] ??= {};
    },
    async getR2Object(a, bucket, key) {
      await enter("getR2Object", [a, bucket, key]);
      return state.r2[bucket]?.[key] ?? null;
    },
    async putR2Object(a, bucket, key, body) {
      await enter("putR2Object", [a, bucket, key, body]);
      const b = state.r2[bucket];
      if (!b) throw new Error(`fakeCloudflare: no bucket ${bucket}`);
      b[key] = body;
    },
    async listWorkflows(a) {
      await enter("listWorkflows", [a]);
      return seed.workflows ?? [];
    },
    async workerSettings(a, script) {
      await enter("workerSettings", [a, script]);
      const bindings = seed.workers?.[script];
      return bindings ? { bindings: structuredClone(bindings) } : null;
    },
    async workerVars(a, script) {
      await enter("workerVars", [a, script]);
      const bindings = seed.workers?.[script];
      return (
        seed.workerVars?.[script] ?? (bindings ? plainTextVars(bindings) : null)
      );
    },
    async listQueues(a) {
      await enter("listQueues", [a]);
      return structuredClone(state.queues);
    },
    async createQueue(a, name) {
      await enter("createQueue", [a, name]);
      const id = `q-${nextId++}`;
      state.queues.push({ id, name, producers: [], consumers: [] });
      return { id };
    },
    async mxRecords(zoneId, name) {
      await enter("mxRecords", [zoneId, name]);
      return (seed.dnsRecords?.[zoneId] ?? [])
        .filter(
          (r) => r.type === "MX" && r.name.toLowerCase() === name.toLowerCase(),
        )
        .map((r) => ({ content: r.content, priority: r.priority ?? null }));
    },
    async emailRouting(zoneId) {
      await enter("emailRouting", [zoneId]);
      const left = pendingReady.get(zoneId);
      if (left !== undefined) {
        if (left <= 1) {
          pendingReady.delete(zoneId);
          state.routing[zoneId] = { enabled: true, status: "ready" };
        } else {
          pendingReady.set(zoneId, left - 1);
        }
      }
      const r = state.routing[zoneId];
      return r ? { ...r } : null;
    },
    async enableEmailRoutingDns(zoneId) {
      await enter("enableEmailRoutingDns", [zoneId]);
      const after = seed.routingReadyAfter ?? 0;
      if (after > 0) pendingReady.set(zoneId, after);
      state.routing[zoneId] = {
        enabled: true,
        status: after > 0 ? "unconfigured" : "ready",
      };
      return { ...state.routing[zoneId] };
    },
    async catchAll(zoneId) {
      await enter("catchAll", [zoneId]);
      const r = state.catchAll[zoneId];
      return r ? structuredClone(r) : null;
    },
    async putCatchAllWorker(zoneId, worker) {
      await enter("putCatchAllWorker", [zoneId, worker]);
      state.catchAll[zoneId] = {
        enabled: true,
        actions: [{ type: "worker", value: [worker] }],
      };
    },
    async listSendingSubdomains(zoneId) {
      await enter("listSendingSubdomains", [zoneId]);
      return (state.sending[zoneId] ?? []).map((x) => ({ ...x }));
    },
    async createSendingSubdomain(zoneId, name) {
      await enter("createSendingSubdomain", [zoneId, name]);
      const sub = { id: `sub-${nextId++}`, name, enabled: true };
      (state.sending[zoneId] ??= []).push(sub);
      return { ...sub };
    },
    async sendingDns(zoneId, subdomainId) {
      await enter("sendingDns", [zoneId, subdomainId]);
      const name = state.sending[zoneId]?.find(
        (x) => x.id === subdomainId,
      )?.name;
      const rows =
        seed.sendingDns?.[subdomainId] ??
        (name === undefined ? undefined : seed.sendingDns?.[name]);
      return structuredClone(rows ?? []);
    },
  };
  return fake;
}

/**
 * A temp saasmail package under `dir` (package.json, worker/build.json, a wrangler package with a bin).
 * "nested": wrangler under <root>/node_modules; "hoisted": beside the package, as npx installs it.
 * Returns the package root.
 */
export function fakePackage(
  dir: string,
  o: {
    version: string;
    commit: string;
    wranglerLayout?: "nested" | "hoisted";
  },
): string {
  const hoisted = o.wranglerLayout === "hoisted";
  const root = hoisted
    ? join(dir, "node_modules", "saasmail")
    : join(dir, "saasmail");
  const wranglerDir = hoisted
    ? join(dir, "node_modules", "wrangler")
    : join(root, "node_modules", "wrangler");
  const put = (p: string, text: string) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  };
  put(
    join(root, "package.json"),
    JSON.stringify({
      name: "saasmail",
      version: o.version,
      saasmailCommit: o.commit,
    }),
  );
  put(
    join(root, "worker", "build.json"),
    JSON.stringify({
      no_bundle: true,
      rules: [{ type: "ESModule", globs: ["**/*.js"] }],
    }),
  );
  put(
    join(wranglerDir, "package.json"),
    JSON.stringify({
      name: "wrangler",
      version: "4.127.0",
      bin: { wrangler: "./bin/wrangler.js" },
    }),
  );
  put(join(wranglerDir, "bin", "wrangler.js"), "");
  return root;
}
