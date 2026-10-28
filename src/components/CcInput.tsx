import { useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CcEntry } from "@/lib/api";

interface CcInputProps {
  value: CcEntry[];
  onChange: (next: CcEntry[]) => void;
  /** Domains we treat as "internal" — used for chip color. */
  internalDomains?: string[];
  /** Placeholder for the typing area when no chips are present. */
  placeholder?: string;
  /** Test id for the input element (form-control identity). */
  testId?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseTokens(raw: string): CcEntry[] {
  // Accept "Name <addr>" or bare addresses, separated by , or ; or whitespace.
  const out: CcEntry[] = [];
  for (const piece of raw.split(/[,;]+/).map((p) => p.trim())) {
    if (!piece) continue;
    const m = piece.match(/^\s*(.*?)\s*<\s*([^>\s]+)\s*>\s*$/);
    if (m && EMAIL_RE.test(m[2])) {
      const name = m[1].replace(/^"|"$/g, "").trim();
      out.push({ email: m[2], name: name || null });
      continue;
    }
    if (EMAIL_RE.test(piece)) out.push({ email: piece });
  }
  return out;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function isInternal(email: string, internalDomains: string[]): boolean {
  if (!internalDomains.length) return false;
  return internalDomains.some((d) => d.toLowerCase() === domainOf(email));
}

function labelOf(c: CcEntry): string {
  if (c.name && c.name.trim()) return c.name.trim();
  const at = c.email.indexOf("@");
  return at === -1 ? c.email : c.email.slice(0, at);
}

/**
 * Editable list of CC contacts. Type an email (or "Name <addr>") and press
 * Enter, comma, or Tab to commit. Click the × on a chip to remove it.
 * Internal contacts (matching `internalDomains`) get a accent tint.
 */
export default function CcInput({
  value,
  onChange,
  internalDomains = [],
  placeholder = "Add CC — Enter to confirm",
  testId,
}: CcInputProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  function commit() {
    const parsed = parseTokens(draft);
    if (parsed.length === 0) return;
    const seen = new Set(value.map((c) => c.email.toLowerCase()));
    const next = [...value];
    for (const p of parsed) {
      if (!seen.has(p.email.toLowerCase())) {
        next.push(p);
        seen.add(p.email.toLowerCase());
      }
    }
    onChange(next);
    setDraft("");
  }

  function remove(email: string) {
    onChange(value.filter((c) => c.email !== email));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      if (draft.trim()) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      // Remove the last chip when backspacing into empty input
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-border-strong bg-card px-2 py-1 shadow-card transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((c) => {
        const internal = isInternal(c.email, internalDomains);
        return (
          <span
            key={c.email}
            title={c.email}
            className={cn(
              "inline-flex items-center gap-1 h-6 rounded-full border pl-2 pr-1 text-xs font-medium leading-none",
              internal
                ? "border-accent-subtle bg-accent-subtle text-accent-subtle-fg"
                : "border-border bg-bg-subtle text-text-secondary",
            )}
          >
            {labelOf(c)}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                remove(c.email);
              }}
              aria-label={`Remove ${c.email}`}
              className="rounded-full p-0.5 text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
            >
              <X size={9} />
            </button>
          </span>
        );
      })}
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (draft.trim()) commit();
        }}
        placeholder={value.length === 0 ? placeholder : ""}
        data-testid={testId}
        className="min-w-[120px] flex-1 border-0 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
      />
    </div>
  );
}
