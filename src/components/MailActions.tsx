import type { ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  BellOff,
  Check,
  CheckCheck,
  Clock,
  FolderInput,
  MoreHorizontal,
  Pin,
  PinOff,
  Star,
  Trash2,
  Undo2,
} from "lucide-react";
import type { MailCategory } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { snoozePresets } from "@/hooks/useMailList";
import { cn } from "@/lib/utils";

/** Right-aligned shortcut letter inside a menu item. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto pl-3 text-[11px] text-text-tertiary" aria-hidden>
      {children}
    </span>
  );
}

/** Per-user mail state a row or thread header shows actions for. */
export interface MailStateLike {
  starred: boolean;
  pinned: boolean;
  archivedAt: number | null;
  snoozedUntil: number | null;
  /** Set while the row is in Trash (shared per inbox). */
  trashedAt?: number | null;
  /** The inbox tab the row sorts into (primary, promotions…). */
  category?: MailCategory;
}

/** Callbacks the inbox wires to updateMailState. All optional. */
export interface MailActionHandlers {
  onToggleStar?: () => void;
  onTogglePin?: () => void;
  /** Archive, or move back to the inbox when already archived. */
  onArchive?: () => void;
  /** Snooze until a unix-seconds time; null wakes the row. */
  onSnooze?: (until: number | null) => void;
  onMarkRead?: () => void;
  /** Move to Trash, shared by the inbox's members (with Undo). */
  onTrash?: () => void;
  /** Take out of Trash. */
  onRestore?: () => void;
  /** Delete forever (asks first). Admins only; Trash only. */
  onDelete?: () => void;
  /** "Move to Primary / Promotions / Social / Updates" for this sender. */
  onMoveToCategory?: (category: MailCategory) => void;
}

export const CATEGORY_LABELS: Record<MailCategory, string> = {
  primary: "Primary",
  promotions: "Promotions",
  social: "Social",
  updates: "Updates",
};
const CATEGORIES: MailCategory[] = [
  "primary",
  "promotions",
  "social",
  "updates",
];

function snoozeLabel(until: number) {
  const d = new Date(until * 1000);
  return d.toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function presetTime(until: number) {
  return new Date(until * 1000).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Items for a snooze menu: the presets, plus "Unsnooze" when snoozed. */
export function SnoozeItems({
  state,
  onSnooze,
}: {
  state?: Pick<MailStateLike, "snoozedUntil">;
  onSnooze: (until: number | null) => void;
}) {
  return (
    <>
      <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
      {snoozePresets().map((p) => (
        <DropdownMenuItem key={p.id} onSelect={() => onSnooze(p.until)}>
          <span className="flex-1">{p.label}</span>
          <span className="text-xs text-text-tertiary">
            {presetTime(p.until)}
          </span>
        </DropdownMenuItem>
      ))}
      {state?.snoozedUntil ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onSnooze(null)}>
            <BellOff /> Unsnooze
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

/** Small square icon button used in row hover bars and thread headers. */
export function IconAction({
  label,
  shortcut,
  onClick,
  children,
  active,
  className,
  testId,
}: {
  label: string;
  /** Keyboard shortcut shown in the tooltip, e.g. "E". */
  shortcut?: string;
  onClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
  active?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-keyshortcuts={shortcut?.toLowerCase()}
      data-testid={testId}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary data-[state=open]:bg-bg-muted data-[state=open]:text-text-primary [&_svg]:size-4",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * The star toggle: an outline star, or a filled one in the star colour.
 */
export function StarToggle({
  starred,
  onToggle,
  className,
}: {
  starred: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  return (
    <IconAction
      label={starred ? "Unstar" : "Star"}
      shortcut="S"
      active={starred}
      onClick={() => onToggle?.()}
      className={cn(starred && "text-star hover:text-star", className)}
    >
      <Star className={cn(starred && "fill-current")} />
    </IconAction>
  );
}

/**
 * Archive / snooze / pin / star buttons in one row. Used in the hover bar of
 * an inbox row (desktop), the thread header and the selection bar.
 */
export function MailActionButtons({
  state,
  handlers,
  className,
  showStar = true,
  compact = false,
}: {
  state: MailStateLike;
  handlers: MailActionHandlers;
  className?: string;
  showStar?: boolean;
  /**
   * List-row hover bar: only the Gmail-style essentials (archive, trash,
   * snooze); pin and star stay in the "⋯" menu and on the row itself, so
   * the bar never covers the sender or subject.
   */
  compact?: boolean;
}) {
  const archived = !!state.archivedAt;
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      {handlers.onRestore && (
        <IconAction
          label="Restore from Trash"
          onClick={handlers.onRestore}
          testId="mail-restore-button"
        >
          <Undo2 />
        </IconAction>
      )}
      {handlers.onDelete && (
        <IconAction
          label="Delete forever"
          onClick={handlers.onDelete}
          testId="mail-delete-forever-button"
          className="hover:bg-destructive-subtle hover:text-destructive"
        >
          <Trash2 />
        </IconAction>
      )}
      {handlers.onArchive && (
        <IconAction
          label={archived ? "Move to inbox" : "Archive"}
          shortcut="E"
          onClick={handlers.onArchive}
        >
          {archived ? <ArchiveRestore /> : <Archive />}
        </IconAction>
      )}
      {handlers.onSnooze && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Snooze"
              title={
                state.snoozedUntil
                  ? `Snoozed until ${snoozeLabel(state.snoozedUntil)} (B)`
                  : "Snooze (B)"
              }
              aria-keyshortcuts="b"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary data-[state=open]:bg-bg-muted [&_svg]:size-4",
                state.snoozedUntil && "text-warning",
              )}
            >
              <Clock />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-60"
            onClick={(e) => e.stopPropagation()}
          >
            <SnoozeItems state={state} onSnooze={handlers.onSnooze} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!compact && handlers.onTogglePin && (
        <IconAction
          label={state.pinned ? "Unpin" : "Pin to top"}
          shortcut="P"
          active={state.pinned}
          onClick={handlers.onTogglePin}
          className={cn(state.pinned && "text-accent hover:text-accent")}
        >
          {state.pinned ? <PinOff /> : <Pin />}
        </IconAction>
      )}
      {handlers.onTrash && (
        <IconAction
          label="Move to Trash"
          shortcut="#"
          onClick={handlers.onTrash}
          testId="mail-trash-button"
        >
          <Trash2 />
        </IconAction>
      )}
      {showStar && !compact && handlers.onToggleStar && (
        <StarToggle starred={state.starred} onToggle={handlers.onToggleStar} />
      )}
    </div>
  );
}

/**
 * The "⋯" row menu: every action in one place. Always shown on touch
 * screens (where there is no hover bar).
 */
export function MailRowMenu({
  state,
  handlers,
  className,
  testId,
  personId,
  label = "Conversation actions",
}: {
  state: MailStateLike;
  handlers: MailActionHandlers;
  className?: string;
  testId?: string;
  personId?: string;
  label?: string;
}) {
  const archived = !!state.archivedAt;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          data-person-id={personId}
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary data-[state=open]:bg-bg-muted data-[state=open]:text-text-primary",
            className,
          )}
        >
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        onClick={(e) => e.stopPropagation()}
      >
        {handlers.onToggleStar && (
          <DropdownMenuItem onSelect={handlers.onToggleStar}>
            <Star className={cn(state.starred && "fill-current text-star")} />
            {state.starred ? "Unstar" : "Star"}
            <Kbd>S</Kbd>
          </DropdownMenuItem>
        )}
        {handlers.onTogglePin && (
          <DropdownMenuItem onSelect={handlers.onTogglePin}>
            {state.pinned ? <PinOff /> : <Pin />}
            {state.pinned ? "Unpin" : "Pin to top"}
            <Kbd>P</Kbd>
          </DropdownMenuItem>
        )}
        {handlers.onArchive && (
          <DropdownMenuItem onSelect={handlers.onArchive}>
            {archived ? <ArchiveRestore /> : <Archive />}
            {archived ? "Move to inbox" : "Archive"}
            <Kbd>E</Kbd>
          </DropdownMenuItem>
        )}
        {handlers.onSnooze && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Clock className="text-text-secondary" />
              {state.snoozedUntil ? "Snoozed" : "Snooze"}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-60">
              <SnoozeItems state={state} onSnooze={handlers.onSnooze} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {handlers.onMarkRead && (
          <DropdownMenuItem onSelect={handlers.onMarkRead}>
            <CheckCheck /> Mark as read
            <Kbd>⇧I</Kbd>
          </DropdownMenuItem>
        )}
        {handlers.onMoveToCategory && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="mail-move-to-tab">
              <FolderInput className="text-text-secondary" />
              Move to tab
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              <DropdownMenuLabel>Always show this sender in</DropdownMenuLabel>
              {CATEGORIES.map((c) => (
                <DropdownMenuItem
                  key={c}
                  onSelect={() => handlers.onMoveToCategory?.(c)}
                >
                  <span className="flex-1">{CATEGORY_LABELS[c]}</span>
                  {state.category === c && <Check className="text-accent" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {handlers.onRestore && (
          <DropdownMenuItem
            data-testid="mail-restore-item"
            onSelect={handlers.onRestore}
          >
            <Undo2 /> Restore
          </DropdownMenuItem>
        )}
        {handlers.onTrash && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="mail-trash-item"
              onSelect={handlers.onTrash}
            >
              <Trash2 /> Move to Trash
              <Kbd>#</Kbd>
            </DropdownMenuItem>
          </>
        )}
        {handlers.onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="person-delete-button"
              onSelect={handlers.onDelete}
              className="text-destructive focus:bg-destructive-subtle focus:text-destructive [&>svg]:text-destructive"
            >
              <Trash2 /> Delete forever
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
