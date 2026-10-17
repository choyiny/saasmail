import { createHash } from "node:crypto";
import type { CatchAll } from "./cloudflare.ts";
import type { ResourceNames } from "./names.ts";
import type { Observed } from "./observe.ts";
import {
  hasStep,
  type InstallState,
  type Provider,
  type Resource,
  type ResourceKind,
} from "./state.ts";

export type ActionKind = ResourceKind | "routing" | "sending";

export type Action = {
  action: "create" | "reuse" | "deploy";
  kind: ActionKind;
  /** The state key: a `ResourceNames` key, `routing:<domain>` or `sending:<domain>`. */
  key: string;
  /** The resource name, or the domain for routing and sending. */
  name: string;
};

export type Plan = {
  installationId: string;
  actions: Action[];
  digest: string;
};

/** The plan cannot go ahead; the message is the text shown to the person. */
export class PlanStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanStop";
  }
}

export interface Desired {
  installationId: string;
  ownershipNonce: string;
  names: ResourceNames;
  inboundDomains: string[];
  provider: Provider;
  /** Email Sending domains; planned only when `provider` is `cloudflare`. */
  sendDomains: string[];
}

type Key = keyof ResourceNames;

const ORDER: { key: Key; kind: ResourceKind }[] = [
  { key: "d1", kind: "d1" },
  { key: "attachments", kind: "r2" },
  { key: "queue", kind: "queue" },
  { key: "workflow", kind: "workflow" },
  { key: "worker", kind: "worker" },
];

export const NO_CHANGE_LINE =
  "No Cloudflare resource or local file was changed.";

const notOurs = (name: string) =>
  new PlanStop(
    `\`${name}\` already exists and was not created by this installation. Nothing was changed.`,
  );

const recordedButMissing = (name: string) =>
  new PlanStop(
    `\`${name}\` is recorded but missing in Cloudflare. It may have been deleted outside this installer. Nothing was changed.`,
  );

const zoneMissing = (domain: string) =>
  new PlanStop(
    `Zone for \`${domain}\` not found in this account. Nothing was changed.`,
  );

export const catchAllElsewhere = (domain: string) =>
  new PlanStop(
    `\`${domain}\`'s catch-all rule already sends mail elsewhere and was not set by this installation. Nothing was changed.`,
  );

function parseObject(
  raw: string | null | undefined,
): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const adoptedMismatch = (name: string) =>
  new PlanStop(
    `\`${name}\` is recorded as adopted, but what exists in Cloudflare is not the resource that was adopted. Nothing was changed.`,
  );

/**
 * A resource recorded as adopted is ours without the marker, row or var checks: the recorded
 * identity must match what is observed (ids for D1 and queues, names for the rest).
 */
function decideAdopted(
  kind: ResourceKind,
  name: string,
  desired: Desired,
  observed: Observed,
  recorded: Resource,
): Action["action"] {
  switch (kind) {
    case "d1": {
      const matches = observed.d1.filter((d) => d.name === name);
      if (matches.length === 0) throw recordedButMissing(name);
      if (!matches.some((d) => d.uuid === recorded.id)) {
        throw adoptedMismatch(name);
      }
      return "reuse";
    }
    case "r2":
      if (!observed.r2.includes(name)) throw recordedButMissing(name);
      if (recorded.name !== name) throw adoptedMismatch(name);
      return "reuse";
    case "queue": {
      const q = observed.queues.find((x) => x.name === name);
      if (!q) throw recordedButMissing(name);
      if (q.id !== recorded.id) throw adoptedMismatch(name);
      return "reuse";
    }
    case "workflow": {
      const matches = observed.workflows.filter((w) => w.name === name);
      if (matches.length === 0) throw recordedButMissing(name);
      if (recorded.name !== name) throw adoptedMismatch(name);
      return "reuse";
    }
    case "worker":
      if (!observed.worker.exists) throw recordedButMissing(name);
      if (recorded.name !== desired.names.worker) throw adoptedMismatch(name);
      return "deploy";
  }
}

/** One resource's action, or a PlanStop. `recorded` is this key's state-file entry, if any. */
function decide(
  key: Key,
  kind: ResourceKind,
  desired: Desired,
  observed: Observed,
  state: InstallState | null,
  recorded: Resource | undefined,
): Action["action"] {
  const name = desired.names[key];
  const { installationId, ownershipNonce } = desired;
  if (recorded?.ownership === "adopted") {
    return decideAdopted(kind, name, desired, observed, recorded);
  }
  const intent = state !== null && hasStep(state, `provision-intent:${key}`);

  switch (kind) {
    case "d1": {
      const matches = observed.d1.filter((d) => d.name === name);
      if (matches.length > 1) {
        throw new PlanStop(
          `More than one D1 database is named \`${name}\`. Nothing was changed.`,
        );
      }
      const db = matches[0];
      if (recorded) {
        if (!db || db.uuid !== recorded.id) {
          throw recordedButMissing(name);
        }
        return "reuse";
      }
      if (!db) {
        return "create";
      }
      const row = observed.d1InstallRow[db.uuid];
      if (
        row &&
        row.installation_id === installationId &&
        row.ownership_nonce === ownershipNonce
      ) {
        return "reuse";
      }
      // A run killed between create and record: our intent, and nothing written to it yet.
      const tables = observed.d1Tables[db.uuid];
      if (intent && tables !== undefined && tables.length === 0) {
        return "reuse";
      }
      throw notOurs(name);
    }
    case "r2": {
      // The marker, not the recorded name, proves ownership. Apply writes the marker before it
      // records the bucket, so a recorded bucket always has one.
      if (!observed.r2.includes(name)) {
        if (recorded) {
          throw recordedButMissing(name);
        }
        return "create";
      }
      const raw = observed.r2Markers[name];
      const m = parseObject(raw);
      if (
        m &&
        m.installationId === installationId &&
        m.ownershipNonce === ownershipNonce &&
        m.key === key
      ) {
        return "reuse";
      }
      // A run stopped between create and marker: our intent, no marker, nothing in it yet.
      if (intent && raw == null && observed.r2Empty[name] === true) {
        return "reuse";
      }
      if (intent) {
        throw new PlanStop(
          `${notOurs(name).message} It may be the bucket this install created before it was interrupted; if it is empty, delete it and run --resume.`,
        );
      }
      throw notOurs(name);
    }
    case "queue": {
      // Queues carry no marker: our worker as a consumer proves it, or our recorded intent
      // while nothing is bound to it yet (created, then interrupted before the deploy).
      const q = observed.queues.find((x) => x.name === name);
      if (!q || (recorded && q.id !== recorded.id)) {
        if (recorded) {
          throw recordedButMissing(name);
        }
        return "create";
      }
      if (q.consumers.some((c) => c.script === desired.names.worker)) {
        return "reuse";
      }
      if (intent && q.producers.length === 0 && q.consumers.length === 0) {
        return "reuse";
      }
      throw notOurs(name);
    }
    case "workflow": {
      const matches = observed.workflows.filter((w) => w.name === name);
      if (matches.length > 1) {
        throw new PlanStop(
          `More than one Workflow is named \`${name}\`. Nothing was changed.`,
        );
      }
      const wf = matches[0];
      if (!wf) {
        if (recorded) {
          throw recordedButMissing(name);
        }
        return "create";
      }
      // Deploying would rebind a Workflow owned by another script: never take it over.
      if (wf.scriptName !== desired.names.worker) {
        throw notOurs(name);
      }
      return "reuse";
    }
    case "worker": {
      if (!observed.worker.exists) {
        if (recorded) {
          throw recordedButMissing(name);
        }
        return "create";
      }
      const m = parseObject(observed.worker.vars?.SAASMAIL_INSTALLATION);
      if (
        m &&
        m.installationId === installationId &&
        m.ownershipNonce === ownershipNonce
      ) {
        return "deploy";
      }
      throw notOurs(name);
    }
  }
}

/**
 * The catch-all of an inbound domain's zone: ours (routing on, enabled, one `worker` action naming our
 * worker) → reuse; absent, disabled, or the dashboard default (one `drop`) → create (apply takes it
 * over); anything else stops. Ours while Email Routing is off → create, so apply turns routing on.
 */
function decideRouting(
  domain: string,
  desired: Desired,
  observed: Observed,
): Action["action"] {
  if (!observed.zones[domain]) {
    throw zoneMissing(domain);
  }
  const r = observed.routing[domain];
  const c = r?.catchAll ?? null;
  const owner = catchAllOwner(c, desired.names.worker);
  if (owner === "ours") {
    return r.enabled && r.status === "ready" ? "reuse" : "create";
  }
  if (owner === "free") {
    return "create";
  }
  throw catchAllElsewhere(domain);
}

/**
 * A zone's catch-all: `ours` (enabled, one `worker` action naming `worker`), `free` (absent,
 * disabled, or the dashboard default of one `drop`: safe to take over) or `taken`.
 */
export function catchAllOwner(
  c: CatchAll | null,
  worker: string,
): "ours" | "free" | "taken" {
  if (!c || !c.enabled) return "free";
  const only = c.actions.length === 1 ? c.actions[0] : undefined;
  if (only?.type === "worker" && only.value?.[0] === worker) return "ours";
  if (only?.type === "drop") return "free";
  return "taken";
}

/** A sending subdomain holds no data: present → reuse, absent → create. */
function decideSending(domain: string, observed: Observed): Action["action"] {
  if (!observed.zones[domain]) {
    throw zoneMissing(domain);
  }
  return observed.sending[domain]?.present ? "reuse" : "create";
}

/** Pure: what install would do, in a fixed order, or a PlanStop when anything is not provably ours. */
export function computePlan(
  desired: Desired,
  observed: Observed,
  state: InstallState | null,
): Plan {
  if (
    state &&
    (state.installationId !== desired.installationId ||
      state.ownershipNonce !== desired.ownershipNonce)
  ) {
    throw new Error(
      `State for ${state.installationId} does not belong to installation ${desired.installationId}`,
    );
  }
  const actions: Action[] = ORDER.map(({ key, kind }) => {
    const recorded = state?.resources.find((r) => r.key === key);
    return {
      action: decide(key, kind, desired, observed, state, recorded),
      kind,
      key,
      name: desired.names[key],
    };
  });
  for (const domain of new Set(desired.inboundDomains)) {
    actions.push({
      action: decideRouting(domain, desired, observed),
      kind: "routing",
      key: `routing:${domain}`,
      name: domain,
    });
  }
  if (desired.provider === "cloudflare") {
    for (const domain of new Set(desired.sendDomains)) {
      actions.push({
        action: decideSending(domain, observed),
        kind: "sending",
        key: `sending:${domain}`,
        name: domain,
      });
    }
  }
  return {
    installationId: desired.installationId,
    actions,
    digest: planDigest(desired.installationId, actions),
  };
}

/** First 12 hex of sha256 over the installation id and the ordered {action, kind, name} list. */
export function planDigest(
  installationId: string,
  actions: Pick<Action, "action" | "kind" | "name">[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        installationId,
        actions.map((a) => [a.action, a.kind, a.name]),
      ]),
    )
    .digest("hex")
    .slice(0, 12);
}

/** Plain text: one aligned line per action, then hostname, URL, mail domains, and the no-change line. */
export function formatPlan(
  plan: Plan,
  inputs: InstallState["inputs"],
  baseUrl: string,
): string {
  const aw = Math.max(...plan.actions.map((a) => a.action.length));
  const kw = Math.max(...plan.actions.map((a) => a.kind.length));
  const lines = plan.actions.map(
    (a) => `${a.action.padEnd(aw)}  ${a.kind.padEnd(kw)}  ${a.name}`,
  );
  const list = (xs: string[]) => (xs.length > 0 ? xs.join(", ") : "(none)");
  lines.push(
    "",
    `Hostname  ${inputs.hostname ?? "workers.dev"}`,
    `URL       ${baseUrl}`,
    `Inbound   ${list(inputs.inboundDomains)}`,
    `Provider  ${inputs.provider}`,
  );
  if (inputs.provider === "cloudflare") {
    lines.push(`Send      ${list(inputs.sendDomains)}`);
  }
  lines.push("", NO_CHANGE_LINE);
  return lines.join("\n");
}
