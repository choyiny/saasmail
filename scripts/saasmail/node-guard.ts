// Imported first by cli.ts: older Node.js gets one clear line instead of a stack trace from a later import.
// (Below Node 22.6 the type-stripped files may not even parse, so this can only help on 22.6 up to 22.17.)

export const MIN_NODE = [22, 18] as const;

/** The message to print when `version` (process.versions.node) is too old, else undefined. */
export function nodeProblem(version: string): string | undefined {
  const [major = 0, minor = 0] = version.split(".").map((n) => Number(n));
  const ok =
    major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return ok
    ? undefined
    : `yarn saasmail needs Node.js ${MIN_NODE.join(".")} or newer (found ${version}).`;
}

const problem = nodeProblem(process.versions.node);
if (problem) {
  console.error(problem);
  process.exit(1);
}
