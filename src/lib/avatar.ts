/**
 * Deterministic avatar tints for initials circles. Colours come from the
 * `--sm-av-N-*` tokens (src/styles/portal.css), so they follow light / dark.
 */
const SLOTS = 8;

export function avatarColor(seed: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const n = (h % SLOTS) + 1;
  return { bg: `var(--sm-av-${n}-bg)`, fg: `var(--sm-av-${n}-fg)` };
}

export function initials(name: string | null | undefined, email: string) {
  const source = name || email.split("@")[0] || "";
  const parts = source.split(/[\s.\-_]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return letters.toUpperCase() || "?";
}
