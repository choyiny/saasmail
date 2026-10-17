// `yarn saasmail <command>`: the deterministic installer (spec docs/superpowers/specs/2026-10-17-deterministic-install-design.md).
// Foundation only: the commands land in later tasks; until then every command prints the usage.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE = `Usage: yarn saasmail <command> [options]

Commands:
  install    Create or update a saasmail installation on Cloudflare
  status     Show a recorded installation and check that it answers
`;

/** The CLI entry. Returns the process exit code. */
export function main(argv: string[], print: (s: string) => void): number {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "help") {
    print(USAGE);
    return 0;
  }
  print(`Unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

/**
 * Whether this module is the program being run. `import.meta.main` exists from Node 22.18/24.2;
 * where it is undefined (an older Node), compare the script path instead.
 */
export function isEntry(
  main: boolean | undefined,
  argv1: string | undefined,
  url: string,
): boolean {
  if (main !== undefined) return main;
  if (argv1 === undefined) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(argv1) === real(fileURLToPath(url));
}

if (isEntry(import.meta.main, process.argv[1], import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), (s) =>
    process.stdout.write(s.endsWith("\n") ? s : `${s}\n`),
  );
}
