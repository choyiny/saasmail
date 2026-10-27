import { X } from "lucide-react";

export interface AttachmentChipsProps {
  files: File[];
  /** Cap in bytes; total > cap → destructive text. */
  capBytes: number;
  onRemove: (index: number) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function AttachmentChips({
  files,
  capBytes,
  onRemove,
}: AttachmentChipsProps) {
  if (files.length === 0) return null;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const over = total > capBytes;

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 pt-1.5">
      {files.map((f, idx) => (
        <span
          key={`${f.name}-${idx}`}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-bg-subtle pl-2 pr-1 text-xs font-medium text-text-primary"
        >
          <span className="max-w-[180px] truncate">{f.name}</span>
          <span className="tabular text-text-tertiary">
            · {formatBytes(f.size)}
          </span>
          <button
            type="button"
            onClick={() => onRemove(idx)}
            className="ml-0.5 rounded-full p-0.5 text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
            aria-label={`Remove ${f.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <span
        className={`tabular ml-auto text-xs ${over ? "font-medium text-destructive" : "text-text-tertiary"}`}
      >
        {formatBytes(total)} / {formatBytes(capBytes)}
      </span>
    </div>
  );
}
