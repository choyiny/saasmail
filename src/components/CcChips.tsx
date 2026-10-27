import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CcEntry {
  email: string;
  name?: string | null;
}

interface CcChipsProps {
  cc: CcEntry[];
  /**
   * Domains we consider "internal" — anyone CC'd from these domains gets
   * a accent tint, others get neutral. Pass the set of sender-identity
   * domains so the visual mapping matches the inbox you actually run.
   */
  internalDomains?: string[];
  /** Visual variant — `"compact"` for chat bubbles, `"inline"` for thread headers. */
  variant?: "compact" | "inline";
  /** Optional className passthrough. */
  className?: string;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function isInternal(email: string, internalDomains: string[]): boolean {
  if (!internalDomains.length) return false;
  const d = domainOf(email);
  return internalDomains.some((id) => id.toLowerCase() === d);
}

function labelOf(c: CcEntry): string {
  if (c.name && c.name.trim()) return c.name.trim();
  // Fall back to local-part when there's no display name.
  const at = c.email.indexOf("@");
  return at === -1 ? c.email : c.email.slice(0, at);
}

/**
 * Inline list of CC'd people, rendered as small pill chips.
 * Internal contacts (matching one of `internalDomains`) get an accent
 * accent; external contacts stay neutral. Empty list renders nothing.
 */
export default function CcChips({
  cc,
  internalDomains = [],
  variant = "inline",
  className,
}: CcChipsProps) {
  if (!cc || cc.length === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1",
        variant === "compact" ? "max-w-full" : "max-w-full",
        className,
      )}
    >
      <span className="font-label inline-flex items-center gap-1 text-[10.5px] text-text-tertiary">
        <Users size={11} />
        Cc
      </span>
      {cc.map((c) => {
        const internal = isInternal(c.email, internalDomains);
        return (
          <span
            key={c.email}
            title={c.email}
            className={cn(
              "inline-flex items-center gap-1 h-5 rounded-full border px-2 text-[11.5px] font-medium leading-none",
              internal
                ? "border-accent-subtle bg-accent-subtle text-accent-subtle-fg"
                : "border-border bg-bg-subtle text-text-secondary",
            )}
          >
            {labelOf(c)}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Inline notice rendered between consecutive messages when the CC roster
 * changes — shows who joined and who left the thread.
 */
interface RosterDiffNoticeProps {
  prev: CcEntry[];
  next: CcEntry[];
  internalDomains?: string[];
}

export function RosterDiffNotice({
  prev,
  next,
  internalDomains = [],
}: RosterDiffNoticeProps) {
  const prevSet = new Set(prev.map((c) => c.email.toLowerCase()));
  const nextSet = new Set(next.map((c) => c.email.toLowerCase()));

  const joined = next.filter((c) => !prevSet.has(c.email.toLowerCase()));
  const left = prev.filter((c) => !nextSet.has(c.email.toLowerCase()));

  if (joined.length === 0 && left.length === 0) return null;

  return (
    <div className="my-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 text-[11px] text-text-tertiary">
      {joined.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="font-medium text-text-secondary">+</span>
          {joined.map((c) => (
            <ChipPlain
              key={c.email}
              entry={c}
              internalDomains={internalDomains}
            />
          ))}
          <span>added</span>
        </span>
      )}
      {joined.length > 0 && left.length > 0 && (
        <span className="text-text-tertiary/40">·</span>
      )}
      {left.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="font-medium text-text-secondary">−</span>
          {left.map((c) => (
            <ChipPlain
              key={c.email}
              entry={c}
              internalDomains={internalDomains}
            />
          ))}
          <span>removed</span>
        </span>
      )}
    </div>
  );
}

function ChipPlain({
  entry,
  internalDomains,
}: {
  entry: CcEntry;
  internalDomains: string[];
}) {
  const internal = isInternal(entry.email, internalDomains);
  return (
    <span
      title={entry.email}
      className={cn(
        "inline-flex items-center h-5 rounded-full border px-2 text-[11.5px] font-medium leading-none",
        internal
          ? "border-accent-subtle bg-accent-subtle text-accent-subtle-fg"
          : "border-border bg-bg-subtle text-text-secondary",
      )}
    >
      {labelOf(entry)}
    </span>
  );
}
