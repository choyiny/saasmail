import { CloudflareError, type Cloudflare } from "./cloudflare.ts";
import type { Runner } from "./runner.ts";

export type Failure = { check: string; message: string; fix: string };

export interface PreflightInput {
  accountId: string;
  hostname: string | null;
  workersDev: boolean;
  workerName: string;
  inboundDomains: string[];
  sendDomains: string[];
  provider: string;
}

interface Outcome {
  failures: Failure[];
  baseUrl?: string | null;
  zones?: Record<string, string | null>;
}

const TOKEN_FIX =
  "Create an API token with the permissions listed in docs/setup.md and log in again.";
const PLANS = "https://dash.cloudflare.com/?to=/:account/workers/plans";

class TokenProblem extends Error {}

function isAuth(e: unknown): e is CloudflareError {
  return e instanceof CloudflareError && (e.status === 401 || e.status === 403);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Wraps one check: a 401/403 becomes a token problem, anything else a failure for `check`. */
async function guard(
  check: string,
  what: string,
  fn: () => Promise<Outcome>,
  fix: string,
): Promise<Outcome> {
  try {
    return await fn();
  } catch (e) {
    if (isAuth(e)) throw new TokenProblem(what);
    return {
      failures: [{ check, message: `Could not check ${what}: ${msg(e)}`, fix }],
    };
  }
}

const one = (check: string, message: string, fix: string): Outcome => ({
  failures: [{ check, message, fix }],
});

/** Whether a Workers route pattern (`host/path`, optionally `*`-prefixed or with a scheme) covers `host`. */
export function routeCovers(pattern: string, host: string): boolean {
  const h = pattern
    .replace(/^https?:\/\//i, "")
    .split("/", 1)[0]!
    .toLowerCase();
  const want = host.toLowerCase();
  return h.startsWith("*") ? want.endsWith(h.slice(1)) : h === want;
}

const CF_MX = /^route[123]\.mx\.cloudflare\.net$/i;
const isCloudflareMx = (content: string) =>
  CF_MX.test(content.trim().replace(/\.$/, ""));

const mxLabel = (c: string) =>
  c.trim() === "" || c.trim() === "." ? 'null MX (".")' : c;

export const FOREIGN_MX_FIX =
  "Use a domain (or subdomain zone) whose mail you want saasmail to receive, or remove those MX records yourself.";

/**
 * Why Email Routing must not be enabled for `domain` (it has MX records other than Cloudflare's own
 * route1–3), or null. Read-only; shared by preflight and apply.
 */
export async function foreignMx(
  cf: Cloudflare,
  zoneId: string,
  domain: string,
): Promise<string | null> {
  const foreign = (await cf.mxRecords(zoneId, domain)).filter(
    (m) => !isCloudflareMx(m.content),
  );
  if (foreign.length === 0) return null;
  return `${domain} already has MX records (${foreign.map((m) => mxLabel(m.content)).join(", ")}). Enabling Email Routing would take over that domain's mail. Nothing was changed.`;
}

/** Read-only checks that run before any plan or write; every check runs and every failure is reported. */
export async function preflight(
  cf: Cloudflare,
  runner: Runner,
  input: PreflightInput,
): Promise<{
  failures: Failure[];
  baseUrl: string | null;
  /** Zone id per checked domain (inbound, send) and the UI hostname; null when no zone was found. */
  zoneIds: Record<string, string | null>;
}> {
  const a = input.accountId;

  const plan = () =>
    guard(
      "plan",
      "the Workers plan (Queues)",
      async () => {
        try {
          await cf.listQueues(a);
          return { failures: [] };
        } catch (e) {
          // Specific first: wrangler's source carries no error code for "Queues need Workers Paid", so match the
          // message (unconfirmed against the live API). Auth errors with other messages still map to `token`.
          if (
            e instanceof CloudflareError &&
            [400, 402, 403].includes(e.status) &&
            /\bworkers paid\b|\bpaid plan\b|\bsubscri|\bupgrade\b/i.test(
              e.message,
            )
          )
            return one(
              "plan",
              "Queues are not available on this account (they need the Workers Paid plan).",
              `Queues need the Workers Paid plan: ${PLANS}`,
            );
          throw e;
        }
      },
      `Queues need the Workers Paid plan: ${PLANS}`,
    );

  const r2 = () =>
    guard(
      "r2",
      "R2",
      async () => {
        try {
          await cf.listR2(a);
          return { failures: [] };
        } catch (e) {
          // 10042 is unverified (not in wrangler's source); the generic r2 failure below keeps the activation link anyway.
          if (e instanceof CloudflareError && e.codes.includes(10042))
            return one(
              "r2",
              "R2 is not enabled on this account.",
              "Enable R2 at https://dash.cloudflare.com/?to=/:account/r2/overview, then run the installer again.",
            );
          throw e;
        }
      },
      "Enable R2 at https://dash.cloudflare.com/?to=/:account/r2/overview.",
    );

  const subdomain = () =>
    guard(
      "workers-dev",
      "the workers.dev subdomain",
      async () => {
        const sub = await cf.workersSubdomain(a);
        if (sub === null)
          return one(
            "workers-dev",
            "The account has no workers.dev subdomain yet.",
            "Open Workers & Pages in the Cloudflare dashboard once so it is created, then run the installer again.",
          );
        return {
          failures: [],
          baseUrl: `https://${input.workerName}.${sub}.workers.dev`,
        };
      },
      "Open Workers & Pages in the Cloudflare dashboard once.",
    );

  const uiHost = () =>
    guard(
      "zone",
      "the hostname zone",
      async () => {
        const host = input.hostname!;
        const z = await cf.findZone(a, host);
        const failures: Failure[] = [];
        if (!z)
          failures.push({
            check: "zone",
            message: `No zone covering ${host} was found in this account.`,
            fix: "Add the domain to this Cloudflare account (or pick a hostname on a zone it already has), then run the installer again.",
          });
        else if (z.status !== "active")
          failures.push({
            check: "zone",
            message: `The zone ${z.name} is ${z.status}, not active.`,
            fix: "Finish the zone setup (point the registrar at Cloudflare nameservers) and wait until it is active.",
          });
        const onHost = (await cf.workerDomains(a)).filter(
          (d) => d.hostname.toLowerCase() === host.toLowerCase(),
        );
        const taken = onHost.find((d) => d.service !== input.workerName);
        if (taken)
          failures.push({
            check: "zone",
            message: `${host} is already served by the worker "${taken.service}".`,
            fix: `Remove that custom domain from "${taken.service}" or choose another hostname.`,
          });
        if (z) {
          // Without a terminal, wrangler's deploy replaces conflicting DNS records and other
          // workers' origins on the hostname: check first. This worker's own custom domain
          // owns its record (a resume), so that one is fine.
          const own = onHost.some((d) => d.service === input.workerName);
          const records = own ? [] : await cf.dnsRecords(z.id, host);
          if (records.length > 0)
            failures.push({
              check: "zone",
              message: `\`${host}\` already has DNS records (${records.map((r) => `${r.type} ${r.content}`).join(", ")}). Nothing was changed.`,
              fix: `Delete those records in the Cloudflare dashboard (DNS → Records for ${z.name}) or choose another hostname.`,
            });
          const scripts = [
            ...new Set(
              (await cf.workerRoutes(z.id))
                .filter(
                  (r) =>
                    r.script !== null &&
                    r.script !== input.workerName &&
                    routeCovers(r.pattern, host),
                )
                .map((r) => r.script!),
            ),
          ];
          if (scripts.length > 0)
            failures.push({
              check: "zone",
              message: `\`${host}\` is routed to ${scripts.map((x) => `\`${x}\``).join(", ")}. Nothing was changed.`,
              fix: `Remove those routes in the Cloudflare dashboard (Workers Routes for ${z.name}) or choose another hostname.`,
            });
        }
        return {
          failures,
          baseUrl: `https://${host}`,
          zones: { [host]: z?.id ?? null },
        };
      },
      "Check the zone and custom domains in the Cloudflare dashboard.",
    );

  const inbound = (domain: string) =>
    guard(
      "zone",
      `the inbound domain ${domain}`,
      async () => {
        const z = await cf.findZone(a, domain);
        if (z && z.name.toLowerCase() !== domain.toLowerCase())
          return {
            ...one(
              "zone",
              `\`${domain}\` is under zone \`${z.name}\`; Email Routing's catch-all is zone-wide, so the inbound domain must be its own zone (add ${domain} as a zone, or use ${z.name}).`,
              `Add ${domain} as its own zone, or use ${z.name} as the inbound domain.`,
            ),
            zones: { [domain]: z.id },
          };
        if (!z)
          return {
            ...one(
              "zone",
              `No zone for ${domain} was found in this account.`,
              "Add the domain to this Cloudflare account (as its own zone), then run the installer again.",
            ),
            zones: { [domain]: null },
          };
        if (z.status !== "active")
          return {
            ...one(
              "zone",
              `The zone ${z.name} is ${z.status}, not active.`,
              "Finish the zone setup (point the registrar at Cloudflare nameservers) and wait until it is active.",
            ),
            zones: { [domain]: z.id },
          };
        const mx = await foreignMx(cf, z.id, domain);
        const failures: Failure[] = mx
          ? [{ check: "mx", message: mx, fix: FOREIGN_MX_FIX }]
          : [];
        return { failures, zones: { [domain]: z.id } };
      },
      "Check the zone and its MX records in the Cloudflare dashboard.",
    );

  const send = (domain: string) =>
    guard(
      "zone",
      `the send domain ${domain}`,
      async () => {
        const z = await cf.findZone(a, domain);
        const zones = { [domain]: z?.id ?? null };
        if (!z)
          return {
            ...one(
              "zone",
              `No zone covering the send domain ${domain} was found in this account.`,
              "Add the domain to this Cloudflare account, then run the installer again.",
            ),
            zones,
          };
        if (z.status !== "active")
          return {
            ...one(
              "zone",
              `The zone ${z.name} is ${z.status}, not active.`,
              "Finish the zone setup (point the registrar at Cloudflare nameservers) and wait until it is active.",
            ),
            zones,
          };
        return { failures: [], zones };
      },
      "Check the zone in the Cloudflare dashboard.",
    );

  const noop = async (): Promise<Outcome> => ({ failures: [] });
  const settled = await Promise.allSettled([
    plan(),
    r2(),
    input.workersDev ? subdomain() : noop(),
    input.hostname ? uiHost() : noop(),
    ...input.inboundDomains.map(inbound),
    ...(input.provider === "cloudflare" ? input.sendDomains.map(send) : []),
  ]);

  const failures: Failure[] = [];
  let baseUrl: string | null = null;
  const zoneIds: Record<string, string | null> = {};
  const denied: string[] = [];
  for (const s of settled) {
    if (s.status === "rejected") {
      if (s.reason instanceof TokenProblem) denied.push(s.reason.message);
      else {
        failures.push({
          check: "preflight",
          message: `Unexpected error: ${msg(s.reason)}`,
          fix: "Run the installer again; report this if it persists.",
        });
      }
      continue;
    }
    failures.push(...s.value.failures);
    Object.assign(zoneIds, s.value.zones);
    // A custom hostname wins over workers.dev.
    if (s.value.baseUrl && (baseUrl === null || input.hostname))
      baseUrl = s.value.baseUrl;
  }
  if (denied.length)
    failures.unshift({
      check: "token",
      message: `The API token cannot read: ${denied.join(", ")}.`,
      fix: TOKEN_FIX,
    });
  return { failures, baseUrl, zoneIds };
}
