// Mail steps for apply.ts (spec §6 steps 7–8) and the closing summary. Both mail steps run after
// the deploy: the catch-all names the worker. The installer reads DNS records; it never writes them.
import type { EmailRoutingSettings, SendingDnsRecord } from "./cloudflare.ts";
import {
  OPTIONAL_ITEMS,
  resumeCommand,
  type Ctx,
  type Optional,
} from "./apply-steps.ts";
import { hasStep, type InstallState } from "./state.ts";

// 13 reads 5 s apart: up to 60 s for Email Routing to report `ready`.
const ROUTING_TRIES = 13;
const ROUTING_INTERVAL_MS = 5000;

/**
 * Turns Email Routing on for the zone when it is off (Cloudflare adds and locks its MX/SPF records),
 * waits for `ready`, then points the zone's catch-all at the worker.
 */
export async function routeDomain(
  ctx: Ctx,
  s: InstallState,
  domain: string,
  zoneId: string,
): Promise<void> {
  let st: EmailRoutingSettings | null = await ctx.cf.emailRouting(zoneId);
  if (!st?.enabled) st = await ctx.cf.enableEmailRoutingDns(zoneId);
  for (let attempt = 1; st?.status !== "ready"; attempt++) {
    if (attempt >= ROUTING_TRIES) {
      throw new Error(
        `Email Routing on ${domain} did not become ready within 60 s (status: ${st?.status ?? "unknown"}). ` +
          "Check the zone's Email Routing page in the Cloudflare dashboard, then resume.",
      );
    }
    await ctx.sleep(ROUTING_INTERVAL_MS);
    st = await ctx.cf.emailRouting(zoneId);
  }
  await ctx.cf.putCatchAllWorker(zoneId, s.names.worker);
}

export type SendingReport = {
  domain: string;
  records: (SendingDnsRecord & { ok: boolean })[];
};

/** Lower case, no surrounding quotes (TXT) and no trailing dot: how two record values compare. */
const norm = (v: string) =>
  v
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .replace(/\.$/, "")
    .toLowerCase();

/**
 * The DNS records `domain`'s Email Sending subdomain needs, each marked ok when the zone holds a
 * record of the same type, name and content. The API reports no per-record status.
 */
export async function sendingReport(
  ctx: Ctx,
  domain: string,
  zoneId: string,
): Promise<SendingReport> {
  const sub = (await ctx.cf.listSendingSubdomains(zoneId)).find(
    (x) => norm(x.name) === norm(domain),
  );
  if (!sub) {
    throw new Error(`The Email Sending subdomain ${domain} was not found.`);
  }
  const required = await ctx.cf.sendingDns(zoneId, sub.id);
  const byName = new Map<string, { type: string; content: string }[]>();
  for (const name of new Set(required.map((r) => norm(r.name)))) {
    byName.set(name, await ctx.cf.dnsRecords(zoneId, name));
  }
  return {
    domain,
    records: required.map((r) => ({
      ...r,
      ok: (byName.get(norm(r.name)) ?? []).some(
        (h) =>
          norm(h.type) === norm(r.type) && norm(h.content) === norm(r.content),
      ),
    })),
  };
}

function sendingLines(reports: SendingReport[]): string[] {
  if (reports.length === 0) return [];
  const lines = ["", "Sending (Cloudflare Email Sending):"];
  for (const r of reports) {
    const missing = r.records.some((x) => !x.ok);
    lines.push(
      missing
        ? `  ${r.domain}: pending — add the missing records to the zone's DNS (they can take 5–15 minutes to propagate)`
        : `  ${r.domain}: ready`,
    );
    for (const x of r.records) {
      const rec = `${x.type} ${x.name} ${x.content}`;
      lines.push(x.ok ? `    ok       ${rec}` : `    missing: ${rec}`);
    }
  }
  return lines;
}

export function summary(
  s: InstallState,
  code: string | null,
  optional: Optional,
  sending: SendingReport[],
): string {
  const lines = [`saasmail is installed at ${s.baseUrl}`, ""];
  if (code) {
    lines.push(
      `Setup code: ${code}`,
      `Open ${s.baseUrl}/onboarding and enter it to create the first admin. It is shown only once.`,
      "",
    );
  }
  const n = s.names;
  lines.push(
    "Set:",
    `  D1 database     ${n.d1}`,
    `  R2 bucket       ${n.attachments}`,
    `  Queue           ${n.queue}`,
    `  Email provider  ${s.inputs.provider}`,
  );
  for (const i of OPTIONAL_ITEMS)
    if (optional[i.field]) lines.push(`  ${i.label}`);

  const routed = s.inputs.inboundDomains.filter((d) =>
    hasStep(s, `routing:${d}`),
  );
  if (routed.length > 0) {
    lines.push("", "Inbound mail (Email Routing catch-all):");
    for (const d of routed) lines.push(`  ${d} → worker ${n.worker}`);
  }
  lines.push(...sendingLines(sending));

  const skipped = OPTIONAL_ITEMS.filter((i) => s.skipped.includes(i.id));
  if (skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const i of skipped) lines.push(`  ${i.label}`);
  }
  lines.push("", `Add domains or credentials later with: ${resumeCommand(s)}`);
  return lines.join("\n");
}
