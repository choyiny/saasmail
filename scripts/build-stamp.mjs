// The build stamp: which commit a build came from, injected as
// `__SAASMAIL_BUILD__` into the Worker bundle only (never the web app, whose
// assets are public). The admin doctor reports it; see docs/doctor.md.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Changed paths named in the stamp; `dirtyCount` has the full count. */
const MAX_DIRTY_FILES = 10;

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  }).replace(/\n$/, ""); // not trim(): a porcelain entry can start with a space
}

/**
 * The paths of `git status --porcelain -z`: NUL-separated and never quoted, so
 * a name with a space or an accent stays plain. A rename or copy entry
 * (`R`/`C`) is followed by its old path as one more field, which is skipped.
 */
export function porcelainPaths(output) {
  const fields = output.split("\0");
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if ("RC".includes(entry[0]) || "RC".includes(entry[1])) i++;
  }
  return paths;
}

export function computeBuildStamp(root, now = new Date()) {
  const { version } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  let migrations = [];
  try {
    migrations = readdirSync(join(root, "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
  } catch {
    // No migrations folder: the doctor's migration check then fails, as it should.
  }
  const stamp = {
    version: String(version),
    commit: "unknown",
    commitShort: "unknown",
    commitTime: null,
    dirty: false,
    dirtyFiles: [],
    dirtyCount: 0,
    builtAt: now.toISOString(),
    migrations,
  };
  try {
    // A source copy without .git (a tarball) keeps "unknown".
    const commit = git(root, ["rev-parse", "HEAD"]);
    stamp.commit = commit;
    stamp.commitShort = commit.slice(0, 7);
    stamp.commitTime = git(root, ["log", "-1", "--format=%cI"]) || null;
    // -uall: an untracked directory's files one by one, so a deeper
    // `--allow-dirty` path can cover them.
    const changed = porcelainPaths(
      git(root, ["status", "--porcelain", "-z", "-uall"]),
    );
    stamp.dirty = changed.length > 0;
    stamp.dirtyFiles = changed.slice(0, MAX_DIRTY_FILES);
    stamp.dirtyCount = changed.length;
  } catch {
    // Not a git checkout, or git is missing.
  }
  return stamp;
}

/**
 * Defines `__SAASMAIL_BUILD__` in every Vite environment except the browser
 * one (the Cloudflare plugin's Worker environment is named after the Worker).
 */
export function buildStampPlugin(root) {
  const value = JSON.stringify(computeBuildStamp(root));
  return {
    name: "saasmail-build-stamp",
    configEnvironment(name) {
      if (name === "client") return;
      return { define: { __SAASMAIL_BUILD__: value } };
    },
  };
}
