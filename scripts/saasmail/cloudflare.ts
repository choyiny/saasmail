// Typed Cloudflare REST client for the installer. Never logs or echoes the token.

export class CloudflareError extends Error {
  status: number;
  codes: number[];
  path: string;
  constructor(message: string, status: number, codes: number[], path: string) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.codes = codes;
    this.path = path;
  }
}

export interface QueueEndpoint {
  type: string;
  /** The Worker for `worker` producers/consumers; null for other types. */
  script: string | null;
}

export interface Queue {
  id: string;
  name: string;
  producers: QueueEndpoint[];
  consumers: QueueEndpoint[];
}

export interface EmailRoutingSettings {
  enabled: boolean;
  /** "ready" | "unconfigured" | "misconfigured" | "misconfigured/locked" | "unlocked"; null when absent. */
  status: string | null;
}

export interface CatchAllAction {
  type: string;
  value?: string[];
}

export interface CatchAll {
  enabled: boolean;
  actions: CatchAllAction[];
}

export interface SendingSubdomain {
  /** The API's `tag` ("Sending subdomain identifier"). */
  id: string;
  name: string;
  enabled: boolean;
}

export interface SendingDnsRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
}

/** One binding from a Worker's settings (fields per type; secrets carry no value). */
export type WorkerBinding = {
  type: string;
  name: string;
  id?: string;
  database_id?: string;
  bucket_name?: string;
  queue_name?: string;
  workflow_name?: string;
  class_name?: string;
  text?: string;
};

export interface Cloudflare {
  listAccounts(): Promise<{ id: string; name: string }[]>;
  workersSubdomain(a: string): Promise<string | null>;
  findZone(
    a: string,
    hostname: string,
  ): Promise<{ id: string; name: string; status: string } | null>;
  workerDomains(a: string): Promise<{ hostname: string; service: string }[]>;
  dnsRecords(
    zoneId: string,
    name: string,
  ): Promise<{ type: string; content: string }[]>;
  workerRoutes(
    zoneId: string,
  ): Promise<{ pattern: string; script: string | null }[]>;
  listD1(a: string): Promise<{ uuid: string; name: string }[]>;
  createD1(a: string, name: string): Promise<{ uuid: string }>;
  queryD1(
    a: string,
    id: string,
    sql: string,
    params?: unknown[],
  ): Promise<Record<string, unknown>[]>;
  listR2(a: string): Promise<string[]>;
  createR2(a: string, name: string): Promise<void>;
  getR2Object(a: string, bucket: string, key: string): Promise<string | null>;
  r2IsEmpty(a: string, bucket: string): Promise<boolean>;
  putR2Object(
    a: string,
    bucket: string,
    key: string,
    body: string,
  ): Promise<void>;
  listWorkflows(a: string): Promise<{ name: string; scriptName: string }[]>;
  workerSettings(
    a: string,
    script: string,
  ): Promise<{ bindings: WorkerBinding[] } | null>;
  workerVars(a: string, script: string): Promise<Record<string, string> | null>;
  listQueues(a: string): Promise<Queue[]>;
  createQueue(a: string, name: string): Promise<{ id: string }>;
  mxRecords(
    zoneId: string,
    name: string,
  ): Promise<{ content: string; priority: number | null }[]>;
  emailRouting(zoneId: string): Promise<EmailRoutingSettings | null>;
  enableEmailRoutingDns(zoneId: string): Promise<EmailRoutingSettings>;
  catchAll(zoneId: string): Promise<CatchAll | null>;
  putCatchAllWorker(zoneId: string, worker: string): Promise<void>;
  listSendingSubdomains(zoneId: string): Promise<SendingSubdomain[]>;
  createSendingSubdomain(
    zoneId: string,
    name: string,
  ): Promise<SendingSubdomain>;
  sendingDns(zoneId: string, subdomainId: string): Promise<SendingDnsRecord[]>;
}

export interface RestOptions {
  /** Injectable so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

interface Envelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: unknown;
  result_info?: {
    page?: number;
    total_pages?: number;
    cursor?: string;
  };
}

const BASE = "https://api.cloudflare.com/client/v4";

interface RawQueue {
  queue_id: string;
  queue_name: string;
  producers?: RawEndpoint[];
  consumers?: RawEndpoint[];
}

interface RawEndpoint {
  type: string;
  script?: string;
  script_name?: string;
  service?: string;
}

interface RawRouting {
  enabled?: boolean;
  status?: string;
}

interface RawSubdomain {
  tag: string;
  name: string;
  enabled?: boolean;
}

function endpoint(e: RawEndpoint): QueueEndpoint {
  return {
    type: e.type,
    script:
      e.type === "worker"
        ? (e.script ?? e.script_name ?? e.service ?? null)
        : null,
  };
}

function routing(r: RawRouting): EmailRoutingSettings {
  return { enabled: r.enabled ?? false, status: r.status ?? null };
}

function subdomain(r: RawSubdomain): SendingSubdomain {
  return { id: r.tag, name: r.name, enabled: r.enabled ?? false };
}
const enc = encodeURIComponent;

/** The `plain_text` bindings as a name -> text map. */
export function plainTextVars(
  bindings: WorkerBinding[],
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const b of bindings) {
    if (b.type === "plain_text" && typeof b.text === "string")
      vars[b.name] = b.text;
  }
  return vars;
}

export function restCloudflare(
  token: string,
  fetchImpl: typeof fetch = fetch,
  options: RestOptions = {},
): Cloudflare {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** One HTTP exchange. GETs retry up to 3 times on 429/5xx; everything else is sent once. */
  async function send(
    method: string,
    path: string,
    init: { query?: Record<string, string>; body?: string; json?: unknown },
  ): Promise<Response> {
    const qs = init.query ? `?${new URLSearchParams(init.query)}` : "";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const retries = method === "GET" ? 3 : 0;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(`${BASE}${path}${qs}`, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new CloudflareError(
          `Cloudflare request failed: ${e instanceof Error ? e.message : String(e)}`,
          0,
          [],
          path,
        );
      }
      if (attempt < retries && (res.status === 429 || res.status >= 500)) {
        const ra = Number(res.headers.get("Retry-After"));
        const wait =
          Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt;
        await sleep(Math.min(wait, 10_000));
        continue;
      }
      return res;
    }
  }

  async function envelope(res: Response, path: string): Promise<Envelope> {
    let env: Envelope | null = null;
    try {
      env = (await res.json()) as Envelope;
    } catch {
      env = null;
    }
    if (!res.ok || !env || env.success !== true) {
      const errors = env?.errors ?? [];
      const msg =
        errors
          .map((e) => e.message)
          .filter(Boolean)
          .join("; ") || `HTTP ${res.status}`;
      throw new CloudflareError(
        `Cloudflare ${path}: ${msg}`,
        res.status,
        errors.map((e) => e.code).filter((c): c is number => c !== undefined),
        path,
      );
    }
    return env;
  }

  async function call<T>(
    method: string,
    path: string,
    init: { query?: Record<string, string>; json?: unknown } = {},
  ): Promise<T> {
    const res = await send(method, path, init);
    return (await envelope(res, path)).result as T;
  }

  /**
   * GET a list, following result_info pages (page/total_pages) or cursor. `perPage` is sent only
   * where the endpoint documents it; the first request carries no page parameter.
   */
  async function list<T>(
    path: string,
    opts: {
      perPage?: number;
      query?: Record<string, string>;
      pick?: (result: unknown) => T[];
    } = {},
  ): Promise<T[]> {
    const pick = opts.pick ?? ((r: unknown) => r as T[]);
    const out: T[] = [];
    let page = 1;
    let cursor: string | undefined;
    for (;;) {
      const q: Record<string, string> = { ...opts.query };
      if (opts.perPage) q.per_page = String(opts.perPage);
      if (cursor) q.cursor = cursor;
      else if (page > 1) q.page = String(page);
      const res = await send("GET", path, { query: q });
      const env = await envelope(res, path);
      out.push(...pick(env.result));
      const info = env.result_info;
      // A repeated cursor means the server is not advancing; stop rather than loop forever.
      if (info?.cursor && info.cursor !== cursor) {
        cursor = info.cursor;
        continue;
      }
      if (!info?.cursor && info?.total_pages && page < info.total_pages) {
        page++;
        continue;
      }
      return out;
    }
  }

  /** Like call(), but a 404 resolves to null. */
  async function orNull<T>(path: string): Promise<T | null> {
    try {
      return await call<T>("GET", path);
    } catch (e) {
      if (e instanceof CloudflareError && e.status === 404) return null;
      throw e;
    }
  }

  const workerSettings = async (a: string, script: string) => {
    const r = await orNull<{ bindings?: WorkerBinding[] }>(
      `/accounts/${a}/workers/scripts/${enc(script)}/settings`,
    );
    return r ? { bindings: r.bindings ?? [] } : null;
  };

  const objectPath = (a: string, bucket: string, key: string) =>
    `/accounts/${a}/r2/buckets/${enc(bucket)}/objects/${key.split("/").map(enc).join("/")}`;

  return {
    // GET /accounts (Cloudflare API docs; per_page max 50).
    async listAccounts() {
      const rows = await list<{ id: string; name: string }>("/accounts", {
        perPage: 50,
      });
      return rows.map((r) => ({ id: r.id, name: r.name }));
    },

    // GET /accounts/{a}/workers/subdomain (wrangler cloudflare@5.2 resources/workers/subdomains); 404 = none registered.
    async workersSubdomain(a) {
      const r = await orNull<{ subdomain?: string }>(
        `/accounts/${a}/workers/subdomain`,
      );
      return r?.subdomain ?? null;
    },

    // GET /zones?account.id=&name= (Cloudflare API docs; spec §4). Walks labels upward, first hit wins.
    async findZone(a, hostname) {
      const labels = hostname.toLowerCase().split(".");
      for (let i = 0; i <= labels.length - 2; i++) {
        const name = labels.slice(i).join(".");
        const zones = await call<
          { id: string; name: string; status: string }[]
        >("GET", "/zones", { query: { "account.id": a, name } });
        const z = zones[0];
        if (z) return { id: z.id, name: z.name, status: z.status };
      }
      return null;
    },

    // GET /accounts/{a}/workers/domains (wrangler cloudflare@5.2 resources/workers/domains).
    async workerDomains(a) {
      const rows = await list<{ hostname: string; service: string }>(
        `/accounts/${a}/workers/domains`,
      );
      return rows.map((r) => ({ hostname: r.hostname, service: r.service }));
    },

    // GET /zones/{z}/dns_records?name.exact= (wrangler cloudflare@5.2 resources/dns/records list; `name.exact`
    // per developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/).
    async dnsRecords(zoneId, name) {
      const rows = await list<{ type: string; content: string }>(
        `/zones/${enc(zoneId)}/dns_records`,
        { perPage: 100, query: { "name.exact": name } },
      );
      return rows.map((r) => ({ type: r.type, content: r.content }));
    },

    // GET /zones/{z}/workers/routes -> [{ id, pattern, script? }] (wrangler cloudflare@5.2 resources/workers/routes
    // list; wrangler's deploy reads `{ pattern, script }` from the same path). No script = a route that runs no worker.
    async workerRoutes(zoneId) {
      const rows = await list<{ pattern: string; script?: string | null }>(
        `/zones/${enc(zoneId)}/workers/routes`,
      );
      return rows.map((r) => ({
        pattern: r.pattern,
        script: r.script ?? null,
      }));
    },

    // GET /accounts/{a}/d1/database (wrangler cloudflare@5.2 resources/d1/database).
    async listD1(a) {
      const rows = await list<{ uuid: string; name: string }>(
        `/accounts/${a}/d1/database`,
        { perPage: 100 },
      );
      return rows.map((r) => ({ uuid: r.uuid, name: r.name }));
    },

    // POST /accounts/{a}/d1/database {name} (wrangler cloudflare@5.2 resources/d1/database create). Not retried.
    async createD1(a, name) {
      const r = await call<{ uuid: string }>(
        "POST",
        `/accounts/${a}/d1/database`,
        { json: { name } },
      );
      return { uuid: r.uuid };
    },

    // POST /accounts/{a}/d1/database/{id}/query {sql, params}; result is one entry per statement, `results` holds rows (wrangler cloudflare@5.2 resources/d1/database query).
    async queryD1(a, id, sql, params) {
      const r = await call<{ results?: Record<string, unknown>[] }[]>(
        "POST",
        `/accounts/${a}/d1/database/${enc(id)}/query`,
        { json: { sql, params: params ?? [] } },
      );
      return r[0]?.results ?? [];
    },

    // GET /accounts/{a}/r2/buckets -> { buckets: [{ name }] } (wrangler src/r2/helpers/bucket.ts listR2Buckets).
    async listR2(a) {
      const rows = await list<{ name: string }>(`/accounts/${a}/r2/buckets`, {
        perPage: 1000,
        pick: (r) => (r as { buckets?: { name: string }[] }).buckets ?? [],
      });
      return rows.map((b) => b.name);
    },

    // POST /accounts/{a}/r2/buckets {name} (wrangler src/r2/helpers/bucket.ts createR2Bucket). Not retried.
    async createR2(a, name) {
      await call("POST", `/accounts/${a}/r2/buckets`, { json: { name } });
    },

    // GET /accounts/{a}/r2/buckets/{b}/objects/{key} returns the raw object, not an envelope; 404 -> null (wrangler getR2Object).
    async getR2Object(a, bucket, key) {
      const path = objectPath(a, bucket, key);
      const res = await send("GET", path, {});
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new CloudflareError(
          `Cloudflare ${path}: HTTP ${res.status}`,
          res.status,
          [],
          path,
        );
      }
      return res.text();
    },

    // GET /accounts/{a}/r2/buckets/{b}/objects?per_page=1 -> result: object list (developers.cloudflare.com/api/
    // resources/r2/subresources/buckets/subresources/objects/methods/list/; wrangler has no list-objects call). One page only.
    async r2IsEmpty(a, bucket) {
      const rows = await call<unknown[]>(
        "GET",
        `/accounts/${a}/r2/buckets/${enc(bucket)}/objects`,
        { query: { per_page: "1" } },
      );
      return rows.length === 0;
    },

    // PUT /accounts/{a}/r2/buckets/{b}/objects/{key} with the raw body (wrangler putR2Object). Not retried.
    async putR2Object(a, bucket, key, body) {
      const path = objectPath(a, bucket, key);
      const res = await send("PUT", path, { body });
      if (!res.ok) {
        throw new CloudflareError(
          `Cloudflare ${path}: HTTP ${res.status}`,
          res.status,
          [],
          path,
        );
      }
    },

    // GET /accounts/{a}/workflows (wrangler `workflows list`, src/workflows/commands/list.ts; fields name, script_name).
    async listWorkflows(a) {
      const rows = await list<{ name: string; script_name: string }>(
        `/accounts/${a}/workflows`,
        { perPage: 100 },
      );
      return rows.map((r) => ({ name: r.name, scriptName: r.script_name }));
    },

    // GET /accounts/{a}/workers/scripts/{s}/settings -> { bindings: [{ type, name, ... }] } (wrangler cloudflare@5.2
    // resources/workers/scripts/settings); 404 -> null. `secret_text` bindings carry names only, never values.
    workerSettings,

    // The `plain_text` bindings of workerSettings. Only plain_text vars are returned, so SAASMAIL_INSTALLATION must
    // be written as a string var.
    async workerVars(a, script) {
      const r = await workerSettings(a, script);
      return r ? plainTextVars(r.bindings) : null;
    },

    // GET /accounts/{a}/queues, paged by `page` (wrangler 4.127 src/queues/client.ts listQueues; no per_page sent, none
    // documented). Items: queue_id, queue_name, producers[{type, script | bucket_name}], consumers[{type, ...}]
    // (developers.cloudflare.com/api/resources/queues/methods/list). A worker consumer names its Worker as `script_name`
    // per the API docs but wrangler reads `script` or `service` (resolveWorkerConsumerByName): all three are accepted.
    async listQueues(a) {
      const rows = await list<RawQueue>(`/accounts/${a}/queues`);
      return rows.map((q) => ({
        id: q.queue_id,
        name: q.queue_name,
        producers: (q.producers ?? []).map(endpoint),
        consumers: (q.consumers ?? []).map(endpoint),
      }));
    },

    // POST /accounts/{a}/queues {queue_name} -> { queue_id } (wrangler 4.127 src/queues/client.ts createQueue + createBody). Not retried.
    async createQueue(a, name) {
      const r = await call<{ queue_id: string }>(
        "POST",
        `/accounts/${a}/queues`,
        { json: { queue_name: name } },
      );
      return { id: r.queue_id };
    },

    // GET /zones/{z}/dns_records?type=MX&name.exact= (same endpoint as dnsRecords; `type` filter and MX `priority` per
    // developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/).
    async mxRecords(zoneId, name) {
      const rows = await list<{ content: string; priority?: number }>(
        `/zones/${enc(zoneId)}/dns_records`,
        { perPage: 100, query: { type: "MX", "name.exact": name } },
      );
      return rows.map((r) => ({
        content: r.content,
        priority: r.priority ?? null,
      }));
    },

    // GET /zones/{z}/email/routing -> { enabled, status, ... } (wrangler 4.127 src/email-routing/client.ts
    // getEmailRoutingSettings; status values per developers.cloudflare.com/api/resources/email_routing/methods/get).
    // 404 -> null (unconfirmed: the docs do not say whether a never-configured zone answers 404 or `enabled: false`).
    async emailRouting(zoneId) {
      const r = await orNull<RawRouting>(`/zones/${enc(zoneId)}/email/routing`);
      return r ? routing(r) : null;
    },

    // POST /zones/{z}/email/routing/dns {} -> settings: enables routing, adds and locks its MX/SPF records (cloudflare@5.2
    // emailRouting.dns.create in wrangler 4.127's bundle; body `name` optional per developers.cloudflare.com/api/resources/
    // email_routing/subresources/dns/methods/create). Not retried.
    async enableEmailRoutingDns(zoneId) {
      const r = await call<RawRouting>(
        "POST",
        `/zones/${enc(zoneId)}/email/routing/dns`,
        { json: {} },
      );
      return routing(r);
    },

    // GET /zones/{z}/email/routing/rules/catch_all -> { enabled, actions[{type: drop|forward|worker, value?}], matchers }
    // (wrangler 4.127 getEmailRoutingCatchAll; schema per developers.cloudflare.com/api/resources/email_routing/subresources/
    // rules/subresources/catch_alls/methods/get). 404 -> null (unconfirmed whether a zone without one answers 404).
    async catchAll(zoneId) {
      const r = await orNull<{
        enabled?: boolean;
        actions?: CatchAllAction[];
      }>(`/zones/${enc(zoneId)}/email/routing/rules/catch_all`);
      if (!r) return null;
      return {
        enabled: r.enabled ?? false,
        actions: (r.actions ?? []).map((x) =>
          x.value ? { type: x.type, value: x.value } : { type: x.type },
        ),
      };
    },

    // PUT /zones/{z}/email/routing/rules/catch_all {matchers, actions, enabled} (wrangler 4.127 updateEmailRoutingCatchAll,
    // body as `email routing rules update catch-all`). Replaces the rule: only after the plan proved it ours or the default. Not retried.
    async putCatchAllWorker(zoneId, worker) {
      await call("PUT", `/zones/${enc(zoneId)}/email/routing/rules/catch_all`, {
        json: {
          matchers: [{ type: "all" }],
          actions: [{ type: "worker", value: [worker] }],
          enabled: true,
        },
      });
    },

    // GET /zones/{z}/email/sending/subdomains -> [{ tag, name, enabled, ... }] (wrangler 4.127 listEmailSendingSubdomains;
    // `tag` is the id per developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/methods/list).
    async listSendingSubdomains(zoneId) {
      const rows = await list<RawSubdomain>(
        `/zones/${enc(zoneId)}/email/sending/subdomains`,
      );
      return rows.map(subdomain);
    },

    // POST /zones/{z}/email/sending/subdomains {name} -> subdomain (wrangler 4.127 createEmailSendingSubdomain). Not retried.
    async createSendingSubdomain(zoneId, name) {
      const r = await call<RawSubdomain>(
        "POST",
        `/zones/${enc(zoneId)}/email/sending/subdomains`,
        { json: { name } },
      );
      return subdomain(r);
    },

    // GET /zones/{z}/email/sending/subdomains/{tag}/dns -> [{ type, name, content, priority?, ttl? }] (wrangler 4.127
    // getEmailSendingSubdomainDns, keyed by `tag`). No per-record status exists in the API (developers.cloudflare.com/api/
    // resources/email_sending/subresources/subdomains/subresources/dns/methods/get): compare with the zone's records instead.
    async sendingDns(zoneId, subdomainId) {
      const rows = await call<
        { type?: string; name?: string; content?: string; priority?: number }[]
      >(
        "GET",
        `/zones/${enc(zoneId)}/email/sending/subdomains/${enc(subdomainId)}/dns`,
      );
      return (rows ?? []).map((r) => {
        const out: SendingDnsRecord = {
          type: r.type ?? "",
          name: r.name ?? "",
          content: r.content ?? "",
        };
        if (r.priority !== undefined) out.priority = r.priority;
        return out;
      });
    },
  };
}
