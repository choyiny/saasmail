// docs/doctor.md: `yarn doctor`, against stubbed wrangler, git and HTTP.
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exitCode,
  main,
  parseArgs,
  parseWranglerConfig,
  pendingMigrations,
  uncoveredDirtyFiles,
} from "./doctor.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const CONFIG = `{
  // The deployment's config.
  "name": "saasmail",
  "d1_databases": [{ "binding": "DB", "database_name": "saasmail-db" }],
  "ai": { "binding": "AI" },
  "r2_buckets": [{ "binding": "R2", "bucket_name": "att" },],
  "queues": { "producers": [{ "binding": "EMAIL_QUEUE", "queue": "q" }] },
  "durable_objects": {
    "bindings": [
      { "name": "NOTIFICATIONS_HUB", "class_name": "NotificationsHub" },
      { "name": "MAIL_AGENT", "class_name": "MailAgent" },
    ],
  },
  "vars": { "UNSUBSCRIBE_SECRET": "x" },
}`;

/** The Worker's mandatory checks, passing; `overrides.checks` replace by id. */
const HEALTHY_CHECKS = [
  ["migrations.pending", "migrations", "All migrations are applied."],
  ["secrets.better_auth", "secrets", "BETTER_AUTH_SECRET is set."],
  ["secrets.dev_flags", "secrets", "Dev flags are off."],
  ["bindings.required", "bindings", "Bound."],
  [
    "provider.outbound",
    "provider",
    "Outbound provider: Resend (ResendSender).",
  ],
].map(([id, group, summary]) => ({ id, group, status: "pass", summary }));

function withChecks(overrides) {
  if (!overrides) return HEALTHY_CHECKS;
  const byId = new Map(overrides.map((c) => [c.id, c]));
  return [
    ...HEALTHY_CHECKS.map((c) => byId.get(c.id) ?? c),
    ...overrides.filter((c) => !HEALTHY_CHECKS.some((h) => h.id === c.id)),
  ];
}

function runtimeReport(overrides = {}) {
  return {
    build: {
      version: "0.10.0",
      commit: SHA,
      commitShort: SHA.slice(0, 7),
      commitTime: "2026-10-29T00:00:00Z",
      dirty: false,
      dirtyFiles: [],
      dirtyCount: 0,
      builtAt: "2026-10-29T00:00:00.000Z",
      ...overrides.build,
    },
    checkedAt: 1,
    checks: withChecks(overrides.checks),
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** A world where everything passes, with per-test overrides. */
function deps(overrides = {}) {
  const calls = [];
  const out = [];
  return {
    calls,
    out,
    deps: {
      readFile: () => CONFIG,
      env: { SAASMAIL_ADMIN_KEY: "sk_admin", ...overrides.env },
      git: async () => SHA,
      print: (text) => out.push(text),
      exec: async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (overrides.exec) {
          const r = await overrides.exec(args);
          if (r) return r;
        }
        if (args.includes("migrations")) {
          return {
            code: 0,
            timedOut: false,
            stdout: "✅ No migrations to apply!",
            stderr: "",
          };
        }
        return {
          code: 0,
          timedOut: false,
          stdout: JSON.stringify([
            { name: "BETTER_AUTH_SECRET", type: "secret_text" },
            { name: "TOKEN_ENCRYPTION_KEY", type: "secret_text" },
          ]),
          stderr: "",
        };
      },
      fetch: async (url, init) => {
        calls.push(String(url));
        if (overrides.fetch) {
          const r = await overrides.fetch(String(url), init);
          if (r) return r;
        }
        if (String(url).endsWith("/api/admin/doctor"))
          return json(runtimeReport());
        if (String(url).endsWith("/api/admin/inboxes"))
          return json([{ email: "help@example.com", source: "cloudflare" }]);
        throw new Error(`unexpected fetch ${url}`);
      },
    },
  };
}

const ARGS = [
  "--config",
  "wrangler.jsonc",
  "--url",
  "https://mail.example.com/",
];

describe("parseArgs", () => {
  it("reads the options and normalises the URL", () => {
    const o = parseArgs([...ARGS, "--strict", "--allow-dirty", "a", "b/"]);
    expect(o).toMatchObject({
      config: "wrangler.jsonc",
      url: "https://mail.example.com",
      strict: true,
      allowDirty: ["a", "b/"],
    });
  });
  it("refuses a missing option or a bad URL", () => {
    expect(() => parseArgs(["--config", "x"])).toThrow(/Usage/);
    expect(() => parseArgs(["--config", "x", "--url", "nope"])).toThrow();
    expect(() =>
      parseArgs(["--config", "x", "--url", "http://mail.example.com"]),
    ).toThrow(/https/);
    for (const url of [
      "http://localhost:8788",
      "http://127.0.0.1:8788",
      "http://[::1]:8788",
    ]) {
      expect(parseArgs(["--config", "x", "--url", url]).url).toBe(
        new URL(url).origin,
      );
    }
  });
});

describe("parseWranglerConfig", () => {
  it("parses JSONC with comments and trailing commas", () => {
    const c = parseWranglerConfig(CONFIG);
    expect(c.name).toBe("saasmail");
    expect(c.database).toBe("saasmail-db");
    expect([...c.bindings].sort()).toEqual(
      [
        "AI",
        "DB",
        "EMAIL_QUEUE",
        "MAIL_AGENT",
        "NOTIFICATIONS_HUB",
        "R2",
      ].sort(),
    );
    expect(c.vars.has("UNSUBSCRIBE_SECRET")).toBe(true);
  });
  it("throws on a syntax error", () => {
    expect(() => parseWranglerConfig('{ "name": }')).toThrow(/invalid JSONC/);
  });
});

describe("helpers", () => {
  it("reads pending migration names", () => {
    expect(pendingMigrations("✅ No migrations to apply!")).toEqual([]);
    expect(
      pendingMigrations("│ 0091_remove-subscribe-forms.sql │\n│ 0092_x.sql │"),
    ).toEqual(["0091_remove-subscribe-forms.sql", "0092_x.sql"]);
    expect(pendingMigrations("Something else entirely")).toBeNull();
  });
  it("exits 1 on a failure, and on a warning only with --strict", () => {
    const warn = [{ status: "pass" }, { status: "warn" }];
    expect(exitCode(warn, false)).toBe(0);
    expect(exitCode(warn, true)).toBe(1);
    expect(exitCode([{ status: "fail" }], false)).toBe(1);
    expect(exitCode([{ status: "info" }], true)).toBe(0);
  });
  it("covers dirty files by path or directory", () => {
    const build = {
      dirty: true,
      dirtyFiles: ["public/logo.svg", "src/x.ts"],
      dirtyCount: 2,
    };
    expect(uncoveredDirtyFiles(build, ["public/"])).toEqual(["src/x.ts"]);
    expect(uncoveredDirtyFiles(build, ["public", "src/x.ts"])).toEqual([]);
    expect(
      uncoveredDirtyFiles({ ...build, dirtyCount: 12 }, ["public", "src"]),
    ).toEqual(["10 more not named in the stamp"]);
  });
});

describe("main", () => {
  it("passes a healthy deployment", async () => {
    const world = deps();
    const { code, lines } = await main(ARGS, world.deps);
    expect(lines.filter((l) => l.status === "fail")).toEqual([]);
    expect(code).toBe(0);
    expect(world.out.join("\n")).toContain("Cloudflare API: skipped");
  });

  it("says it could not compare the commit outside a git checkout", async () => {
    const world = deps();
    world.deps.git = async () => null;
    const { lines } = await main(ARGS, world.deps);
    const line = lines.find((l) => l.label.startsWith("Deployed commit"));
    expect(line.status).toBe("info");
    expect(line.label).toContain("could not compare");
    expect(line.label).not.toContain("matches");
  });

  it("never prints the admin key or the token", async () => {
    const world = deps({ env: { CLOUDFLARE_API_TOKEN: "cf_secret_token" } });
    world.deps.fetch = async (url) => {
      if (url.endsWith("/api/admin/doctor")) return json(runtimeReport());
      if (url.endsWith("/api/admin/inboxes")) return json([]);
      throw new Error("unreachable");
    };
    await main(ARGS, world.deps);
    const out = world.out.join("\n");
    expect(out).not.toContain("sk_admin");
    expect(out).not.toContain("cf_secret_token");
  });

  it("exits 1 when the migrations list fails", async () => {
    const world = deps({
      exec: async (args) =>
        args.includes("migrations")
          ? { code: 1, timedOut: false, stdout: "", stderr: "Not logged in" }
          : null,
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(1);
    expect(lines.find((l) => l.status === "fail").label).toContain(
      "Not logged in",
    );
  });

  it("exits 1 on a pending migration", async () => {
    const world = deps({
      exec: async (args) =>
        args.includes("migrations")
          ? {
              code: 0,
              timedOut: false,
              stdout: "│ 0092_new.sql │",
              stderr: "",
            }
          : null,
    });
    expect((await main(ARGS, world.deps)).code).toBe(1);
  });

  it("exits 1 when the endpoint answers 401", async () => {
    const world = deps({
      fetch: async (url) =>
        url.endsWith("/api/admin/doctor")
          ? json({ error: "Unauthorized" }, 401)
          : null,
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(1);
    expect(lines.some((l) => l.label.includes("HTTP 401"))).toBe(true);
  });

  it("exits 1 on a malformed body", async () => {
    const world = deps({
      fetch: async (url) =>
        url.endsWith("/api/admin/doctor") ? json({ ok: true }) : null,
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(1);
    expect(lines.some((l) => l.label.includes("has no build"))).toBe(true);
  });

  it("exits 1 on a report with no checks, an unknown status or a missing mandatory check, even without --strict", async () => {
    const bodies = [
      { ...runtimeReport(), checks: [] },
      runtimeReport({
        checks: [{ id: "cron.last_tick", status: "great", summary: "x" }],
      }),
      {
        ...runtimeReport(),
        checks: HEALTHY_CHECKS.filter((c) => c.id !== "secrets.dev_flags"),
      },
    ];
    for (const body of bodies) {
      const world = deps({
        fetch: async (url) =>
          url.endsWith("/api/admin/doctor") ? json(body) : null,
      });
      const { code, lines } = await main(ARGS, world.deps);
      expect(code).toBe(1);
      expect(
        lines.some(
          (l) =>
            l.status === "fail" && l.label.startsWith("GET /api/admin/doctor"),
        ),
      ).toBe(true);
    }
  });

  it("exits 1 when the migrations list output cannot be read", async () => {
    const world = deps({
      exec: async (args) =>
        args.includes("migrations")
          ? {
              code: 0,
              timedOut: false,
              stdout: "Upgrade wrangler!",
              stderr: "",
            }
          : null,
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(1);
    expect(lines.some((l) => l.label.includes("could not be read"))).toBe(true);
  });

  it("exits 1 on a timeout", async () => {
    const world = deps({
      fetch: async (url) => {
        if (!url.endsWith("/api/admin/doctor")) return null;
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(1);
    expect(lines.some((l) => l.label.includes("timed out"))).toBe(true);
  });

  it("exits 1 when a runtime check fails", async () => {
    const world = deps({
      fetch: async (url) =>
        url.endsWith("/api/admin/doctor")
          ? json(
              runtimeReport({
                checks: [
                  {
                    id: "migrations.pending",
                    group: "migrations",
                    status: "fail",
                    summary: "1 migration not applied",
                  },
                ],
              }),
            )
          : null,
    });
    expect((await main(ARGS, world.deps)).code).toBe(1);
  });

  it("--allow-dirty clears a matching dirty stamp", async () => {
    const dirty = runtimeReport({
      build: { dirty: true, dirtyFiles: ["public/logo.svg"], dirtyCount: 1 },
    });
    const fetchDirty = async (url) =>
      url.endsWith("/api/admin/doctor") ? json(dirty) : null;

    const plain = await main(
      [...ARGS, "--strict"],
      deps({ fetch: fetchDirty }).deps,
    );
    expect(plain.code).toBe(1);
    expect(plain.lines.some((l) => l.label.includes("public/logo.svg"))).toBe(
      true,
    );

    const allowed = await main(
      [...ARGS, "--strict", "--allow-dirty", "public/logo.svg"],
      deps({ fetch: fetchDirty }).deps,
    );
    expect(allowed.code).toBe(0);
  });

  it("checks Email Routing, and skips the Sending check for a non-Cloudflare provider", async () => {
    const world = deps({
      env: { CLOUDFLARE_API_TOKEN: "cf" },
      fetch: async (url) => {
        if (url.includes("/zones?")) {
          return json({
            success: true,
            result: url.includes("name=example.com")
              ? [{ id: "z1", name: "example.com" }]
              : [],
          });
        }
        if (url.includes("/email/routing/rules/catch_all")) {
          return json({ success: true, result: { enabled: false } });
        }
        if (url.includes("/email/routing/rules")) {
          return json({
            success: true,
            result: [
              {
                enabled: true,
                matchers: [
                  { type: "literal", field: "to", value: "help@example.com" },
                ],
                actions: [{ type: "worker", value: ["saasmail"] }],
              },
            ],
          });
        }
        return null;
      },
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(0);
    expect(
      lines.find((l) => l.label.startsWith("Email Routing: help@")).status,
    ).toBe("pass");
    expect(
      lines.find((l) => l.label.startsWith("Email Sending")).label,
    ).toContain("not applicable");
    expect(world.calls.some((c) => c.includes("/email/sending/"))).toBe(false);
  });
});

describe("Email Routing rules", () => {
  // Per zone: the address's literal rule (if any) wins over the catch-all, and
  // only an action that names this Worker (`saasmail` in CONFIG) routes to it.
  const toWorker = (name) => [{ type: "worker", value: [name] }];
  const ZONES = {
    "one.test": { rules: [], catchAll: toWorker("saasmail") },
    "two.test": {
      rules: [{ to: "b@two.test", actions: toWorker("other-worker") }],
      catchAll: toWorker("saasmail"),
    },
    "three.test": { rules: [], catchAll: toWorker("other-worker") },
    "four.test": {
      rules: [
        {
          to: "d@four.test",
          actions: [{ type: "forward", value: ["d@elsewhere.test"] }],
        },
      ],
      catchAll: toWorker("saasmail"),
    },
    "five.test": {
      rules: [{ to: "E@Five.test", actions: toWorker("saasmail") }],
      catchAll: { enabled: false },
    },
    // A catch-all covers the apex only: sub.seven.test needs its own rule.
    "seven.test": { rules: [], catchAll: toWorker("saasmail") },
    // A disabled literal rule is not applied: the catch-all decides.
    "six.test": {
      rules: [
        { to: "f@six.test", actions: toWorker("other-worker"), enabled: false },
      ],
      catchAll: toWorker("saasmail"),
    },
  };

  it("passes a catch-all or literal rule to this Worker and fails one to another", async () => {
    const world = deps({
      env: { CLOUDFLARE_API_TOKEN: "cf" },
      fetch: async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith("/api/admin/inboxes")) {
          return json([
            ...["a@one.test", "b@two.test", "c@three.test", "d@four.test"].map(
              (email) => ({ email, source: "cloudflare" }),
            ),
            { email: "e@five.test", source: "cloudflare" },
            { email: "f@six.test", source: "cloudflare" },
            { email: "g@sub.seven.test", source: "cloudflare" },
            { email: "me@gmail.com", source: "gmail" },
          ]);
        }
        if (u.pathname.endsWith("/zones")) {
          const name = u.searchParams.get("name");
          return json({
            success: true,
            result: ZONES[name] ? [{ id: name, name }] : [],
          });
        }
        const match = u.pathname.match(
          /\/zones\/([^/]+)\/email\/routing\/rules(\/catch_all)?$/,
        );
        if (match) {
          const zone = ZONES[match[1]];
          if (match[2]) {
            const catchAll = Array.isArray(zone.catchAll)
              ? {
                  enabled: true,
                  matchers: [{ type: "all" }],
                  actions: zone.catchAll,
                }
              : zone.catchAll;
            return json({ success: true, result: catchAll });
          }
          return json({
            success: true,
            result: zone.rules.map((r) => ({
              enabled: r.enabled ?? true,
              matchers: [{ type: "literal", field: "to", value: r.to }],
              actions: r.actions,
            })),
            result_info: { total_pages: 1 },
          });
        }
        return null;
      },
    });
    const { code, lines } = await main(ARGS, world.deps);
    const routing = (address) =>
      lines.find(
        (l) => l.label.startsWith("Email Routing") && l.label.includes(address),
      )?.status;
    expect(routing("a@one.test")).toBe("pass");
    expect(routing("b@two.test")).toBe("fail");
    expect(routing("c@three.test")).toBe("fail");
    expect(routing("d@four.test")).toBe("fail");
    expect(routing("e@five.test")).toBe("pass");
    expect(routing("f@six.test")).toBe("pass");
    expect(routing("g@sub.seven.test")).toBe("fail");
    expect(
      lines.find((l) => l.label.includes("not applicable to 1 Gmail"))?.status,
    ).toBe("info");
    expect(world.calls.some((c) => c.includes("name=gmail.com"))).toBe(false);
    expect(code).toBe(1);
  });
});

describe("the entry point", () => {
  it("runs main and exits 1 when started through a symlinked path", () => {
    // deploy.sh runs `yarn doctor` from wherever the clone is, and macOS's
    // /tmp and /var are symlinks: a guard that compares argv[1] with the real
    // module path skips main() there and exits 0, so a failing deploy passes.
    const script = resolve("scripts/doctor.mjs");
    const link = join(
      mkdtempSync(join(tmpdir(), "saasmail-doctor-")),
      "doctor.mjs",
    );
    symlinkSync(script, link);
    for (const entry of [script, link]) {
      const run = spawnSync(process.execPath, [entry], { encoding: "utf8" });
      expect(run.stderr, entry).toContain("Usage: yarn doctor");
      expect(run.status, entry).toBe(1);
    }
  });
});
