import {
  Archive,
  CheckCheck,
  Clock3,
  EyeOff,
  Folder,
  Loader2,
  ShieldAlert,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Mailbox } from "@/lib/api";
import {
  nextMondayAtEight,
  snoozeInHours,
  tomorrowAtEight,
} from "@/components/mail/SnoozeMenu";

interface MailSelectionBarProps {
  count: number;
  busy: boolean;
  canArchiveSpam: boolean;
  markSeen: boolean;
  star: boolean;
  archive: boolean;
  spam: boolean;
  trash: boolean;
  mailboxes: Mailbox[];
  onSeen: () => void;
  onStar: () => void;
  onArchive: () => void;
  onSpam: () => void;
  onTrash: () => void;
  onSnooze: (until: number) => void;
  onMove: (mailboxId: string) => void;
  onClear: () => void;
}

export default function MailSelectionBar({
  count,
  busy,
  canArchiveSpam,
  markSeen,
  star,
  archive,
  spam,
  trash,
  mailboxes,
  onSeen,
  onStar,
  onArchive,
  onSpam,
  onTrash,
  onSnooze,
  onMove,
  onClear,
}: MailSelectionBarProps) {
  if (count === 0) return null;

  const actionClass =
    "inline-flex shrink-0 items-center gap-1 rounded-[6px] bg-white/[0.08] px-2 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-white/[0.14] disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div
      data-testid="mail-selection-bar"
      className="fixed bottom-3 left-3 right-3 z-40 flex items-center gap-1 overflow-x-auto rounded-[8px] bg-text-primary px-2 py-2 text-white shadow-lg ring-1 ring-text-primary/20 md:static md:mx-2 md:mt-2 md:shrink-0"
    >
      <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-white/15 px-2 text-xs font-bold tabular-nums">
        {count}
      </span>

      <button
        type="button"
        onClick={onSeen}
        disabled={busy}
        className={actionClass}
      >
        {markSeen ? <CheckCheck size={12} /> : <EyeOff size={12} />}
        {markSeen ? "Seen" : "Unseen"}
      </button>

      <button
        type="button"
        onClick={onStar}
        disabled={busy}
        className={actionClass}
      >
        <Star size={12} />
        {star ? "Star" : "Unstar"}
      </button>

      {canArchiveSpam && (
        <>
          <button
            type="button"
            data-testid="mail-bulk-archive"
            onClick={onArchive}
            disabled={busy}
            className={actionClass}
          >
            <Archive size={12} />
            {archive ? "Archive" : "Unarchive"}
          </button>
          <button
            type="button"
            data-testid="mail-bulk-spam"
            onClick={onSpam}
            disabled={busy}
            className={actionClass}
          >
            <ShieldAlert size={12} />
            {spam ? "Spam" : "Not spam"}
          </button>
        </>
      )}

      <button
        type="button"
        onClick={onTrash}
        disabled={busy}
        className={actionClass}
      >
        <Trash2 size={12} />
        {trash ? "Trash" : "Restore"}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={busy} className={actionClass}>
            <Clock3 size={12} />
            Snooze
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onSnooze(snoozeInHours(3))}>
            In 3 hours
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSnooze(tomorrowAtEight())}>
            Tomorrow at 08:00
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSnooze(nextMondayAtEight())}>
            Next Monday at 08:00
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {mailboxes.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" disabled={busy} className={actionClass}>
              <Folder size={12} />
              Move
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {mailboxes.map((mailbox) => (
              <DropdownMenuItem
                key={mailbox.id}
                onSelect={() => onMove(mailbox.id)}
                data-testid="mail-bulk-move-folder"
                data-mailbox-id={mailbox.id}
              >
                <Folder className="h-4 w-4" />
                {mailbox.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <button
        type="button"
        onClick={onClear}
        disabled={busy}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-50"
        aria-label="Clear mail selection"
      >
        {busy ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <X size={12} />
        )}
        Clear
      </button>
    </div>
  );
}
