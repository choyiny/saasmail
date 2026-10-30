import type { MailboxColor } from "@/lib/api";

/**
 * Tailwind classes per folder colour, written out so the build keeps them:
 * the dot in the rail and the picker, and the chip on a message row.
 */
export const FOLDER_COLOR_CLASSES: Record<
  MailboxColor,
  { dot: string; chip: string }
> = {
  red: { dot: "bg-red-500", chip: "bg-red-500/15 text-red-700" },
  orange: { dot: "bg-orange-500", chip: "bg-orange-500/15 text-orange-700" },
  amber: { dot: "bg-amber-500", chip: "bg-amber-500/15 text-amber-700" },
  yellow: { dot: "bg-yellow-400", chip: "bg-yellow-400/20 text-yellow-800" },
  lime: { dot: "bg-lime-500", chip: "bg-lime-500/15 text-lime-800" },
  green: { dot: "bg-green-500", chip: "bg-green-500/15 text-green-700" },
  teal: { dot: "bg-teal-500", chip: "bg-teal-500/15 text-teal-700" },
  cyan: { dot: "bg-cyan-500", chip: "bg-cyan-500/15 text-cyan-700" },
  blue: { dot: "bg-blue-500", chip: "bg-blue-500/15 text-blue-700" },
  violet: { dot: "bg-violet-500", chip: "bg-violet-500/15 text-violet-700" },
  purple: { dot: "bg-purple-500", chip: "bg-purple-500/15 text-purple-700" },
  pink: { dot: "bg-pink-500", chip: "bg-pink-500/15 text-pink-700" },
};

/** A folder without a colour. */
export const NEUTRAL_CHIP = "bg-bg-muted text-text-secondary";
