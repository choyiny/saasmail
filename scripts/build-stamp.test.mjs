// docs/doctor.md: the build stamp names the changed paths a deploy overlays, so
// `yarn doctor --allow-dirty <path>` can clear them. Runs real git in a temp repo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeBuildStamp } from "./build-stamp.mjs";
import { uncoveredDirtyFiles } from "./doctor.mjs";

function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), "saasmail-stamp-"));
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args],
      { cwd: root, stdio: "ignore" },
    );
  git("init", "-q");
  writeFileSync(join(root, "package.json"), '{ "version": "1.2.3" }');
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "original");
  }
  git("add", "-A");
  git("commit", "-qm", "init");
  return root;
}

describe("computeBuildStamp dirtyFiles", () => {
  it("names an overlaid file with a space or an accent as its plain path", () => {
    // A deploy overlays the logos of Assigamé: tracked files, edited in place.
    const files = [
      "src/assets/logo-assigamé.png",
      "src/assets/my logo.png",
      "src/assets2/other.png",
    ];
    const root = repoWith(files);
    for (const file of files) writeFileSync(join(root, file), "overlay");

    const stamp = computeBuildStamp(root);
    expect(stamp.dirty).toBe(true);
    expect(stamp.dirtyCount).toBe(3);
    expect([...stamp.dirtyFiles].sort()).toEqual([...files].sort());
    // The directory covers its own files and not its sibling `src/assets2`.
    expect(uncoveredDirtyFiles(stamp, ["src/assets"])).toEqual([
      "src/assets2/other.png",
    ]);
  });
});
