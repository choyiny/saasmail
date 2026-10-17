// Imported first by cli.ts: older Node.js gets one clear line instead of a stack trace from a later import.
// (Below Node 22.6 the type-stripped files may not even parse, so this can only help on 22.6 up to 22.17.)

export const MIN_NODE = [22, 18] as const;

/** The message to print when `version` (process.versions.node) is too old, else undefined. */
export function nodeProblem(
  version: string,
  floor: readonly [number, number] = MIN_NODE,
): string | undefined {
  const [major = 0, minor = 0] = version.split(".").map((n) => Number(n));
  const ok = major > floor[0] || (major === floor[0] && minor >= floor[1]);
  if (ok) return undefined;
  // The package says "22 or newer"; the checkout names the exact minor and its command.
  return floor[1] === 0
    ? `saasmail needs Node.js ${floor[0]} or newer (found ${version}).`
    : `yarn saasmail needs Node.js ${floor.join(".")} or newer (found ${version}).`;
}

// The npm bundle defines __SAASMAIL_PACKAGE_ROOT__ and so takes the package's floor.
const problem = nodeProblem(
  process.versions.node,
  typeof __SAASMAIL_PACKAGE_ROOT__ === "string" ? [22, 0] : MIN_NODE,
);
if (problem) {
  console.error(problem);
  process.exit(1);
}
