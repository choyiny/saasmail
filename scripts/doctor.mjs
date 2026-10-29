#!/usr/bin/env node
// Checks one saasmail deployment after a deploy: the config, pending D1
// migrations, secret names, the deployed commit, the Worker's own runtime
// checks (GET /api/admin/doctor) and, with a token, Email Routing and Email
// Sending on Cloudflare. See docs/doctor.md.
//
//   SAASMAIL_ADMIN_KEY=sk_… [DOCTOR_CLOUDFLARE_API_TOKEN=…] \
//     yarn doctor --config <wrangler file> --url <base url>
//       [--strict] [--allow-dirty <path>…] [--local]
//
// Exit code 1 on any failure, and on any warning with --strict. Never prints
// the admin key or the token.

import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

const WRANGLER_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const CF_API = "https://api.cloudflare.com/client/v4";

const REQUIRED_BINDINGS = [
  "DB",
  "R2",
  "EMAIL_QUEUE",
  "NOTIFICATIONS_HUB",
  "MAIL_AGENT",
];
const OPTIONAL_BINDINGS = ["AI", "BACKUPS", "GMAIL_BACKFILL", "EMAIL"];
const NEEDED_SECRETS = ["BETTER_AUTH_SECRET", "UNSUBSCRIBE_SECRET"];

export const SYMBOLS = { pass: "✓", warn: "!", fail: "✗", info: "i" };

const USAGE =
  "Usage: yarn doctor --config <wrangler file> --url <base url> [--strict] [--allow-dirty <path>…] [--local]";

export function parseArgs(argv) {
  const options = {
    config: null,
    url: null,
    strict: false,
    local: false,
    allowDirty: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value. ${USAGE}`);
      }
      return next;
    };
    if (arg === "--config") options.config = value();
    else if (arg === "--url") options.url = value();
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--allow-dirty") {
      options.allowDirty.push(value());
      // `--allow-dirty a b c`: every following bare word is a path.
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
        options.allowDirty.push(argv[++i]);
      }
    } else throw new Error(`Unknown argument ${arg}. ${USAGE}`);
  }
  if (!options.config || !options.url) throw new Error(USAGE);
  let url;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error(`--url is not a URL: ${options.url}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`--url must be http(s): ${options.url}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local) {
    // The admin key would travel in clear text.
    throw new Error(
      `--url must use https:// for ${url.hostname} (http:// is only for localhost).`,
    );
  }
  options.url = url.origin;
  return options;
}

/** The parts of a Wrangler JSONC config the doctor reads. Throws on a syntax error. */
export function parseWranglerConfig(text) {
  const errors = [];
  const config = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !config || typeof config !== "object") {
    const first = errors[0];
    throw new Error(
      first
        ? `invalid JSONC (${printParseErrorCode(first.error)} at offset ${first.offset})`
        : "the file is not a JSON object",
    );
  }
  const names = (list) =>
    Array.isArray(list) ? list.map((x) => x?.binding ?? x?.name) : [];
  const bindings = new Set(
    [
      ...names(config.d1_databases),
      ...names(config.r2_buckets),
      ...names(config.queues?.producers),
      ...names(config.durable_objects?.bindings),
      ...names(config.workflows),
      ...names(config.send_email),
      config.ai?.binding,
    ].filter(Boolean),
  );
  const db = Array.isArray(config.d1_databases)
    ? (config.d1_databases.find((d) => d?.binding === "DB") ??
      config.d1_databases[0])
    : null;
  return {
    name: typeof config.name === "string" ? config.name : null,
    database: db?.database_name ?? null,
    bindings,
    vars: new Set(Object.keys(config.vars ?? {})),
  };
}

/** A `dirtyFiles` entry is allowed when it is an allowed path or under one. */
export function uncoveredDirtyFiles(build, allowDirty) {
  if (!build?.dirty) return [];
  const allowed = allowDirty.map((p) => p.replace(/\/+$/, ""));
  const files = Array.isArray(build.dirtyFiles) ? build.dirtyFiles : [];
  const left = files.filter(
    (file) => !allowed.some((p) => file === p || file.startsWith(`${p}/`)),
  );
  // More changed paths than the stamp names: the unnamed ones are not covered.
  const hidden = Number(build.dirtyCount ?? files.length) - files.length;
  if (hidden > 0) left.push(`${hidden} more not named in the stamp`);
  return left;
}

/** Script lines first, then the Worker's checks, as one list. */
export function mergeReports(scriptLines, runtime) {
  const runtimeLines = (runtime?.checks ?? []).map((c) => ({
    status: c.status,
    label: c.summary,
    hint: c.hint,
    runtime: true,
  }));
  return [...scriptLines, ...runtimeLines];
}

export function exitCode(lines, strict) {
  if (lines.some((l) => l.status === "fail")) return 1;
  if (strict && lines.some((l) => l.status === "warn")) return 1;
  return 0;
}

export function formatLine(line) {
  const head = `${SYMBOLS[line.status] ?? "?"} ${line.label}`;
  return line.hint ? `${head}\n    → ${line.hint}` : head;
}

export function summarize(lines) {
  const n = (s) => lines.filter((l) => l.status === s).length;
  return `${n("pass")} passed, ${n("warn")} warning(s), ${n("fail")} failure(s), ${n("info")} note(s).`;
}

/** Pending names from `wrangler d1 migrations list`, or [] for "No migrations to apply". */
/**
 * Pending names from `wrangler d1 migrations list`: [] only for its explicit
 * "No migrations to apply", the names of its table otherwise, and null for
 * output it cannot classify (which must not pass a deploy).
 */
export function pendingMigrations(stdout) {
  if (/No migrations to apply/i.test(stdout)) return [];
  const names = [...new Set(stdout.match(/\b\d{4}_[\w.-]+\.sql\b/g) ?? [])];
  return names.length > 0 ? names : null;
}

/**
 * Secret names from `wrangler secret list --format json`, or null when the
 * output holds no JSON array. Wrangler can print a notice (a newer version is
 * available) on stdout before the JSON, so parsing starts at the first line
 * that opens the array.
 */
export function secretNames(stdout) {
  const start = stdout.search(/^\s*\[/m);
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? parsed.map((s) => s?.name) : null;
  } catch {
    return null;
  }
}

/** The Worker checks a report must carry: without them nothing was judged. */
export const MANDATORY_RUNTIME_CHECKS = [
  "migrations.pending",
  "secrets.better_auth",
  "secrets.dev_flags",
  "bindings.required",
  "provider.outbound",
];
const STATUSES = new Set(["pass", "warn", "fail", "info"]);

/** Why a doctor response cannot be trusted, or null when it can. */
export function invalidRuntimeReport(body) {
  if (!body || typeof body.build !== "object" || body.build === null) {
    return "the body has no build";
  }
  if (!Array.isArray(body.checks)) return "the body has no checks";
  const bad = body.checks.find(
    (c) =>
      !c ||
      typeof c.id !== "string" ||
      !STATUSES.has(c.status) ||
      typeof c.summary !== "string",
  );
  if (bad) {
    return `a check is malformed (${typeof bad?.id === "string" ? bad.id : "no id"})`;
  }
  const ids = new Set(body.checks.map((c) => c.id));
  const missing = MANDATORY_RUNTIME_CHECKS.filter((id) => !ids.has(id));
  return missing.length > 0
    ? `mandatory checks missing: ${missing.join(", ")}`
    : null;
}

function defaultExec(command, args, { timeoutMs }) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          timedOut: Boolean(error?.killed),
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

async function defaultGit(args) {
  const r = await defaultExec("git", args, { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Why a command failed, for the report: Wrangler's own `[ERROR]` line when it
 * printed one (its last line is usually the path of its log file), else the
 * last line of output.
 */
export function reason(result) {
  if (result.timedOut) return "timed out";
  const text = `${result.stderr}\n${result.stdout}`
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const error = text.findLast((l) => l.includes("[ERROR]"));
  const line = error?.replace(/^✘\s*\[ERROR\]\s*/, "") ?? text.at(-1);
  return line?.slice(0, 200) ?? `exit code ${result.code}`;
}

async function getJson(fetchImpl, url, headers) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ok: false, error: timedOut ? "timed out" : "unreachable" };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, error: "the body is not JSON" };
  }
}

/** Cloudflare API GET: the envelope's `result`, every page. */
async function cfGet(fetchImpl, token, path, query = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ ...query, page: String(page) });
    const r = await getJson(fetchImpl, `${CF_API}${path}?${qs}`, {
      Authorization: `Bearer ${token}`,
    });
    if (!r.ok || r.body?.success !== true) {
      throw new Error(
        `Cloudflare ${path}: ${r.ok ? "not successful" : r.error}`,
      );
    }
    if (!Array.isArray(r.body.result)) return r.body.result;
    out.push(...r.body.result);
    const total = r.body.result_info?.total_pages ?? 1;
    if (page >= total) return out;
  }
}

/** The zone of a domain, walking labels up (`mail.example.com` → `example.com`). */
async function findZone(fetchImpl, token, domain) {
  const labels = domain.toLowerCase().split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const zones = await cfGet(fetchImpl, token, "/zones", {
      name: labels.slice(i).join("."),
    });
    if (zones[0]?.id) return zones[0];
  }
  return null;
}

const enabled = (rule) => rule?.enabled !== false;
const routesToWorker = (rule, worker) =>
  enabled(rule) &&
  (rule?.actions ?? []).some(
    (a) =>
      a?.type === "worker" &&
      Array.isArray(a.value) &&
      a.value.includes(worker),
  );

async function cloudflareLines({ fetchImpl, token, worker, inboxes, runtime }) {
  const lines = [];
  const domainOf = (address) => address.split("@")[1]?.toLowerCase();
  const zones = new Map();
  const zoneFor = async (domain) => {
    if (!zones.has(domain))
      zones.set(domain, findZone(fetchImpl, token, domain));
    return zones.get(domain);
  };

  const routed = inboxes.filter((i) => i.source === "cloudflare");
  const mapped = inboxes.length - routed.length;
  if (mapped > 0) {
    lines.push({
      status: "info",
      label: `Email Routing: not applicable to ${mapped} Gmail- or Outlook-sourced inbox(es).`,
    });
  }
  const rulesByZone = new Map();
  for (const inbox of routed) {
    const address = inbox.email.toLowerCase();
    try {
      const zone = await zoneFor(domainOf(address));
      if (!zone) {
        lines.push({
          status: "fail",
          label: `Email Routing: no Cloudflare zone found for ${address}.`,
          hint: "Add the domain to Cloudflare, or check the token's Zone Read scope.",
        });
        continue;
      }
      if (!rulesByZone.has(zone.id)) {
        rulesByZone.set(
          zone.id,
          Promise.all([
            cfGet(fetchImpl, token, `/zones/${zone.id}/email/routing/rules`, {
              per_page: "50",
            }),
            cfGet(
              fetchImpl,
              token,
              `/zones/${zone.id}/email/routing/rules/catch_all`,
            ).catch(() => null),
          ]),
        );
      }
      const [rules, catchAll] = await rulesByZone.get(zone.id);
      // Cloudflare does not apply a disabled rule: the catch-all decides then.
      const own = (rules ?? []).find(
        (rule) =>
          enabled(rule) &&
          (rule?.matchers ?? []).some(
            (m) =>
              m?.type === "literal" &&
              m?.field === "to" &&
              String(m?.value).toLowerCase() === address,
          ),
      );
      // A catch-all covers the zone's apex only: a subdomain needs its rule.
      const apex = domainOf(address) === String(zone.name).toLowerCase();
      const ok = own
        ? routesToWorker(own, worker)
        : apex && routesToWorker(catchAll, worker);
      lines.push(
        ok
          ? {
              status: "pass",
              label: `Email Routing: ${address} → ${worker}${own ? "" : " (catch-all)"}.`,
            }
          : {
              status: "fail",
              label: `Email Routing: ${address} does not reach the Worker ${worker}.`,
              hint: apex
                ? `In the zone's Email Routing, route ${address} (or the catch-all) to the Worker ${worker}.`
                : `Add an Email Routing rule for ${address} to the Worker ${worker}: the zone's catch-all does not cover a subdomain.`,
            },
      );
    } catch (e) {
      lines.push({
        status: "warn",
        label: `Email Routing for ${address} could not be checked: ${e.message}`,
      });
    }
  }

  const outbound = runtime.checks.find((c) => c.id === "provider.outbound");
  if (!outbound?.summary?.includes("CloudflareSender")) {
    lines.push({
      status: "info",
      label:
        "Email Sending: not applicable (the outbound provider is not Cloudflare).",
    });
    return lines;
  }
  const sendingDomains = [
    ...new Set(inboxes.map((i) => domainOf(i.email)).filter(Boolean)),
  ];
  for (const domain of sendingDomains) {
    try {
      const zone = await zoneFor(domain);
      if (!zone) {
        lines.push({
          status: "fail",
          label: `Email Sending: no Cloudflare zone found for ${domain}.`,
        });
        continue;
      }
      const subs = await cfGet(
        fetchImpl,
        token,
        `/zones/${zone.id}/email/sending/subdomains`,
      );
      const sub = (subs ?? []).find(
        (s) => String(s?.name).toLowerCase() === domain,
      );
      lines.push(
        sub && sub.enabled !== false
          ? { status: "pass", label: `Email Sending is enabled for ${domain}.` }
          : {
              status: "fail",
              label: `Email Sending is not enabled for ${domain}.`,
              hint: `Enable Email Sending for ${domain} in the Cloudflare dashboard.`,
            },
      );
    } catch (e) {
      lines.push({
        status: "warn",
        label: `Email Sending for ${domain} could not be checked: ${e.message}`,
      });
    }
  }
  return lines;
}

/**
 * Runs every check and returns `{ lines, code }`. `deps` replaces the outside
 * world in tests: `exec(command, args, { timeoutMs })`, `fetch`, `git(args)`,
 * `env`, `readFile`, `print`.
 */
export async function main(argv, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const fetchImpl = deps.fetch ?? fetch;
  const git = deps.git ?? defaultGit;
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const print = deps.print ?? ((text) => console.log(text));
  const options = parseArgs(argv);
  const lines = [];
  const emit = (line) => {
    lines.push(line);
    print(formatLine(line));
  };

  // 1. Config.
  let config = null;
  try {
    config = parseWranglerConfig(readFile(options.config));
    const missing = REQUIRED_BINDINGS.filter((b) => !config.bindings.has(b));
    const optional = OPTIONAL_BINDINGS.filter((b) => config.bindings.has(b));
    emit({
      status: missing.length > 0 ? "warn" : "pass",
      label: `Config: worker ${config.name ?? "(no name)"}, database ${config.database ?? "(none)"}; ${
        missing.length > 0
          ? `missing bindings: ${missing.join(", ")}`
          : "all required bindings declared"
      }${optional.length > 0 ? `; optional: ${optional.join(", ")}` : ""}.`,
    });
  } catch (e) {
    emit({
      status: "fail",
      label: `Config ${options.config} could not be read: ${e.message}`,
    });
  }

  const wranglerArgs = (args) => [
    "wrangler",
    ...args,
    "--config",
    options.config,
  ];

  // 2. Pending migrations.
  if (!config?.database) {
    emit({
      status: "fail",
      label:
        "Migrations: no D1 database in the config, so they cannot be listed.",
    });
  } else {
    const r = await exec(
      "npx",
      wranglerArgs([
        "d1",
        "migrations",
        "list",
        config.database,
        options.local ? "--local" : "--remote",
      ]),
      { timeoutMs: WRANGLER_TIMEOUT_MS },
    );
    if (r.code !== 0 || r.timedOut) {
      emit({
        status: "fail",
        label: `Migrations could not be listed: ${reason(r)}`,
      });
    } else {
      const pending = pendingMigrations(r.stdout);
      emit(
        pending === null
          ? {
              status: "fail",
              label:
                "Migrations: the output of `wrangler d1 migrations list` could not be read.",
            }
          : pending.length > 0
            ? {
                status: "fail",
                label: `Migrations: ${pending.length} pending (${pending.slice(0, 3).join(", ")}${pending.length > 3 ? ", …" : ""}).`,
                hint: `npx wrangler d1 migrations apply ${config.database} ${options.local ? "--local" : "--remote"} --config ${options.config}`,
              }
            : { status: "pass", label: "Migrations: none pending." },
      );
    }
  }

  // 3. Secret names (informational; the runtime report is authoritative).
  if (options.local) {
    emit({ status: "info", label: "Secrets: skipped with --local." });
  } else {
    const r = await exec(
      "npx",
      wranglerArgs(["secret", "list", "--format", "json"]),
      { timeoutMs: WRANGLER_TIMEOUT_MS },
    );
    const names = r.code === 0 && !r.timedOut ? secretNames(r.stdout) : null;
    if (!names) {
      emit({
        status: "warn",
        label: `Secrets could not be listed: ${r.code === 0 ? "unexpected output" : reason(r)}`,
      });
    } else {
      for (const name of NEEDED_SECRETS) {
        const set = names.includes(name) || config?.vars.has(name);
        emit(
          set
            ? { status: "pass", label: `${name} is set.` }
            : {
                status: "fail",
                label: `${name} is neither a secret nor a var.`,
                hint: `npx wrangler secret put ${name} --config ${options.config}`,
              },
        );
      }
      const others = names.filter((n) => n && !NEEDED_SECRETS.includes(n));
      emit({
        status: "info",
        label: `Other secrets: ${others.length > 0 ? others.sort().join(", ") : "none"}.`,
      });
    }
  }

  // 4. Deployed commit, and 5. the runtime checks.
  const key = env.SAASMAIL_ADMIN_KEY;
  let runtime = null;
  if (!key) {
    emit({
      status: "fail",
      label: "SAASMAIL_ADMIN_KEY is not set: the runtime checks cannot run.",
      hint: "Create an API key for an admin user and export it as SAASMAIL_ADMIN_KEY.",
    });
  } else {
    const r = await getJson(fetchImpl, `${options.url}/api/admin/doctor`, {
      Authorization: `Bearer ${key}`,
    });
    if (!r.ok) {
      emit({
        status: "fail",
        label: `GET /api/admin/doctor: ${r.error}.`,
        hint:
          r.error === "HTTP 401" || r.error === "HTTP 403"
            ? "SAASMAIL_ADMIN_KEY must be an API key of an admin user."
            : undefined,
      });
    } else if (invalidRuntimeReport(r.body)) {
      emit({
        status: "fail",
        label: `GET /api/admin/doctor: ${invalidRuntimeReport(r.body)}.`,
      });
    } else {
      runtime = r.body;
    }
  }

  if (runtime) {
    const { build } = runtime;
    const deployed = String(build.commit ?? "unknown");
    const [head, originMain] = await Promise.all([
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", "origin/main"]),
    ]);
    const short = (sha) => (sha ? sha.slice(0, 7) : "unknown");
    if (deployed === "unknown") {
      emit({
        status: "warn",
        label: `Deployed: ${build.version}, commit unknown (built without git).`,
      });
    } else if (!head && !originMain) {
      emit({
        status: "info",
        label: `Deployed commit ${short(deployed)} (${build.version}, built ${build.builtAt}): could not compare, no local HEAD or origin/main (not a git checkout).`,
      });
    } else {
      const differs = [
        head && head !== deployed && `local HEAD is ${short(head)}`,
        originMain &&
          originMain !== deployed &&
          `origin/main is ${short(originMain)}`,
      ].filter(Boolean);
      emit(
        differs.length > 0
          ? {
              status: "warn",
              label: `Deployed commit ${short(deployed)} differs: ${differs.join(", ")}.`,
            }
          : {
              status: "pass",
              label: `Deployed commit ${short(deployed)} (${build.version}, built ${build.builtAt}) matches${head ? " HEAD" : ""}${originMain ? " and origin/main" : ""}.`,
            },
      );
    }
    const dirty = uncoveredDirtyFiles(build, options.allowDirty);
    if (dirty.length > 0) {
      emit({
        status: "warn",
        label: `The deployed build had uncommitted changes: ${dirty.join(", ")}.`,
        hint: "Commit them, or name a deliberate overlay with --allow-dirty <path>.",
      });
    } else if (build.dirty) {
      emit({
        status: "pass",
        label: "The deployed build's changes are all allowed overlays.",
      });
    }
    print("Runtime checks:");
    for (const line of mergeReports([], runtime)) {
      lines.push(line);
      print(`  ${formatLine(line).replace(/\n/g, "\n  ")}`);
    }
  }

  // 6. Cloudflare API. The doctor's own variable comes first: Wrangler also
  // signs in with CLOUDFLARE_API_TOKEN, so a read-only token there would make
  // steps 2 and 3 fail.
  const token = env.DOCTOR_CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    emit({
      status: "info",
      label: "Cloudflare API: skipped (no DOCTOR_CLOUDFLARE_API_TOKEN).",
    });
  } else if (!runtime || !config?.name) {
    emit({
      status: "warn",
      label:
        "Cloudflare API: skipped (needs the runtime report and the worker name).",
    });
  } else {
    const r = await getJson(fetchImpl, `${options.url}/api/admin/inboxes`, {
      Authorization: `Bearer ${key}`,
    });
    if (!r.ok || !Array.isArray(r.body)) {
      emit({
        status: "warn",
        label: `Cloudflare API: the inbox list could not be read (${r.ok ? "unexpected body" : r.error}).`,
      });
    } else {
      const cfLines = await cloudflareLines({
        fetchImpl,
        token,
        worker: config.name,
        inboxes: r.body.filter((i) => typeof i?.email === "string"),
        runtime,
      });
      for (const line of cfLines) emit(line);
    }
  }

  const code = exitCode(lines, options.strict);
  print(summarize(lines));
  return { lines, code };
}

/** Run directly, also through a symlink (macOS /tmp and /var are symlinks). */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then(({ code }) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
