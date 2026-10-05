import { readFileSync } from "node:fs";

const lockfile = readFileSync(new URL("../yarn.lock", import.meta.url), "utf8");
const missing = lockfile
  .trimEnd()
  .split(/\n{2,}/)
  .filter(
    (block) =>
      /^\s*resolved\s+"/m.test(block) && !/^\s*integrity\s+/m.test(block),
  )
  .map((block) => block.split("\n")[0]);

if (missing.length > 0) {
  console.error("Lockfile entries with resolved URLs but no integrity:");
  for (const entry of missing) console.error(`- ${entry}`);
  process.exit(1);
}

console.log("Lockfile integrity OK: all resolved entries have integrity.");
