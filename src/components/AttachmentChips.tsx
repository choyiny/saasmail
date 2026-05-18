import { X } from "lucide-react";

export interface AttachmentChipsProps {
  files: File[];
  /** Cap in bytes; total > cap → red text. */
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
          className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
        >
          <span className="max-w-[180px] truncate">{f.name}</span>
          <span className="text-gray-500">· {formatBytes(f.size)}</span>
          <button
            type="button"
            onClick={() => onRemove(idx)}
            className="ml-0.5 rounded hover:bg-gray-200"
            aria-label={`Remove ${f.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <span
        className={`ml-auto text-xs ${over ? "text-red-600 font-medium" : "text-gray-500"}`}
      >
        {formatBytes(total)} / {formatBytes(capBytes)}
      </span>
    </div>
  );
}
