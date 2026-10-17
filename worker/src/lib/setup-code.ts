/**
 * The one-time setup code. `yarn saasmail install` sets `SETUP_CODE_HASH` (the hash of a code it
 * prints) as a secret; while it is set, the first admin can only be created with the code.
 * The Node CLI computes the same hash: strip dashes and whitespace, upper-case, SHA-256, lowercase hex.
 */

/** Lowercase hex SHA-256 of the code with dashes and whitespace removed, upper-cased. */
export async function setupCodeHash(code: string): Promise<string> {
  const normalised = code.replace(/[\s-]/g, "").toUpperCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalised),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Any env shape. */
function configuredHash(env: object): string {
  const v = (env as { SETUP_CODE_HASH?: unknown }).SETUP_CODE_HASH;
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/** Whether a setup code is configured (an empty secret counts as unset). */
export function setupCodeRequired(env: object): boolean {
  return configuredHash(env) !== "";
}

/** True when no code is configured, or `code` hashes to the configured digest (constant time). */
export async function verifySetupCode(
  env: CloudflareBindings,
  code: string | undefined,
): Promise<boolean> {
  const expected = configuredHash(env);
  if (expected === "") return true;
  if (!code) return false;
  const actual = await setupCodeHash(code);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++)
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
