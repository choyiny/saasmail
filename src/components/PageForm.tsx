import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared layout primitives for "settings-style" admin pages —
 * TemplateEditor, SequenceEditor, SequenceDetail, etc. Keeps the
 * label/input/hint shape and code-block presentation identical
 * everywhere so fields read the same wherever they're used.
 */

export const FORM_INPUT_CLASS =
  "h-9 w-full rounded-lg border border-border-strong bg-card px-3 text-sm text-text-primary shadow-card transition-[border-color,box-shadow] placeholder:text-text-tertiary hover:border-text-tertiary/60 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-60";

interface SectionHeaderProps {
  icon?: React.ElementType;
  title: string;
  subtitle?: React.ReactNode;
  /** Optional element to render flush to the right of the title row. */
  action?: React.ReactNode;
}

export function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  action,
}: SectionHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        {Icon && (
          <Icon size={16} className="mt-0.5 shrink-0 text-text-secondary" />
        )}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-snug tracking-[-0.01em] text-text-primary">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-[13px] text-text-secondary">{subtitle}</p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, hint, children, className }: FieldProps) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-[13px] font-medium text-text-primary">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1.5 block text-xs text-text-tertiary">{hint}</span>
      )}
    </label>
  );
}

/** Pill-style label used at the top of code/preview panes. */
export function PaneLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 border-b border-border bg-bg-subtle px-3 py-2">
      <span className="font-label text-[10.5px] text-text-tertiary">
        {children}
      </span>
    </div>
  );
}

/** Read-only code block with a copy button in the corner. */
export function CodeBlock({
  value,
  oneLine,
}: {
  value: string;
  oneLine?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="relative">
      <pre
        className={cn(
          "overflow-x-auto rounded-lg border border-border bg-bg-subtle p-3 pr-20 text-xs leading-relaxed text-text-primary",
          oneLine ? "whitespace-nowrap" : "whitespace-pre",
        )}
      >
        <code className="font-code">{value}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy"
        className="absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded-md border border-border-strong bg-card px-2 text-xs font-medium text-text-secondary shadow-card transition-colors hover:bg-bg-subtle hover:text-text-primary"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
