import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntry, main, USAGE } from "../cli.ts";

describe("cli stub", () => {
  it("prints usage for no command and --help, exit 0", () => {
    for (const argv of [[], ["--help"], ["help"]]) {
      const out: string[] = [];
      expect(main(argv, (s) => out.push(s))).toBe(0);
      expect(out.join("\n")).toBe(USAGE);
    }
  });

  it("an unknown command prints usage and exits 2", () => {
    const out: string[] = [];
    expect(main(["frobnicate"], (s) => out.push(s))).toBe(2);
    expect(out.join("\n")).toContain("Unknown command: frobnicate");
    expect(out.join("\n")).toContain(USAGE);
  });

  it("isEntry prefers import.meta.main, else compares real paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-cli-"));
    const file = join(dir, "cli.ts");
    writeFileSync(file, "");
    const link = join(dir, "link.ts");
    symlinkSync(file, link);
    const url = pathToFileURL(file).href;
    expect(isEntry(true, undefined, url)).toBe(true);
    expect(isEntry(false, file, url)).toBe(false);
    expect(isEntry(undefined, link, url)).toBe(true);
    expect(isEntry(undefined, join(dir, "other.ts"), url)).toBe(false);
    expect(isEntry(undefined, undefined, url)).toBe(false);
  });
});
