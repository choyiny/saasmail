import { mkdtempSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutSource, packageSource } from "../source.ts";
import { fakePackage, fakeRunner } from "./fakes.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "source-")));

describe("checkoutSource", () => {
  const s = checkoutSource("/r");
  it("wrangler goes through yarn", () => {
    expect(s.wrangler(["secret", "list"], "/r")).toEqual({
      cmd: "yarn",
      args: ["-s", "wrangler", "secret", "list"],
    });
    expect(s.wranglerCommand("d1 list")).toBe("yarn wrangler d1 list");
    expect(s.wranglerBare(["auth", "token"])).toEqual({
      cmd: "yarn",
      args: ["-s", "wrangler", "auth", "token"],
    });
  });
  it("deploy", () => {
    expect(s.deploy("/r", null)).toEqual({
      cmd: "yarn",
      args: ["-s", "deploy"],
    });
    expect(s.deploy("/r", "/tmp/s.json").args).toEqual([
      "-s",
      "deploy",
      "--secrets-file",
      "/tmp/s.json",
    ]);
  });
  it("command and null package fields", () => {
    expect(s.command("install --resume --name acme")).toBe(
      "yarn saasmail install --resume --name acme",
    );
    expect(s.commit).toBeNull();
    expect(s.build).toBeNull();
  });
  it("version is the short sha, -dirty with changes", async () => {
    const runner = fakeRunner({
      "git rev-parse": () => ({
        code: 0,
        stdout: "abc123def456\n",
        stderr: "",
      }),
      "git status": () => ({ code: 0, stdout: " M x\n", stderr: "" }),
    });
    expect(await s.version(runner)).toBe("abc123def456-dirty");
  });
});

describe.each(["nested", "hoisted"] as const)(
  "packageSource (%s)",
  (layout) => {
    const setup = () => {
      const root = fakePackage(tmp(), {
        version: "1.2.0",
        commit: "abc123def456",
        wranglerLayout: layout,
      });
      return { root, s: packageSource(root) };
    };
    const binOf = (root: string) =>
      layout === "nested"
        ? join(root, "node_modules", "wrangler", "bin", "wrangler.js")
        : join(root, "..", "wrangler", "bin", "wrangler.js");

    it("wrangler runs its own bin", () => {
      const { root, s } = setup();
      expect(
        s.wrangler(["d1", "migrations", "apply", "DB", "--remote"], "/home/x"),
      ).toEqual({
        cmd: process.execPath,
        args: [
          realpathSync(binOf(root)),
          "d1",
          "migrations",
          "apply",
          "DB",
          "--remote",
          "--config",
          "/home/x/wrangler.jsonc",
        ],
      });
      expect(s.wranglerCommand("tail")).toBe("npx wrangler@4.127.0 tail");
    });
    it("wranglerBare runs its own bin without --config", () => {
      const { root, s } = setup();
      expect(s.wranglerBare(["auth", "token"])).toEqual({
        cmd: process.execPath,
        args: [realpathSync(binOf(root)), "auth", "token"],
      });
    });
    it("deploy", () => {
      const { root, s } = setup();
      const bin = realpathSync(binOf(root));
      expect(s.deploy("/home/x", null)).toEqual({
        cmd: process.execPath,
        args: [bin, "deploy", "--config", "/home/x/wrangler.jsonc"],
      });
      expect(s.deploy("/home/x", "/tmp/s.json").args).toEqual([
        bin,
        "deploy",
        "--config",
        "/home/x/wrangler.jsonc",
        "--secrets-file",
        "/tmp/s.json",
      ]);
    });
    it("version, commit, build", async () => {
      const { root, s } = setup();
      const runner = fakeRunner({});
      expect(await s.version(runner)).toBe("1.2.0");
      expect(runner.calls).toHaveLength(0);
      expect(s.commit).toBe("abc123def456");
      expect(s.build?.main).toBe(join(root, "worker", "index.js"));
      expect(s.build?.assetsDir).toBe(join(root, "client"));
      expect(s.build?.moduleConfig.no_bundle).toBe(true);
      expect(s.templatePath).toBe(join(root, "wrangler.jsonc.example"));
      expect(s.migrationsDir).toBe(join(root, "migrations"));
    });
    it("moduleConfig drops path-valued keys (base_dir)", () => {
      const { root } = setup();
      writeFileSync(
        join(root, "worker", "build.json"),
        JSON.stringify({ no_bundle: true, base_dir: "/build/worker" }),
      );
      const s = packageSource(root);
      expect(s.build?.moduleConfig).toEqual({ no_bundle: true });
    });
    it("command", () => {
      expect(setup().s.command("install --resume --name acme")).toBe(
        "npx saasmail@1.2.0 install --resume --name acme",
      );
    });
  },
);
