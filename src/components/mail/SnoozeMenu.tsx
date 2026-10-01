import { Clock3 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function snoozeInHours(hours: number): number {
  return unixSeconds(new Date(Date.now() + hours * 60 * 60 * 1000));
}

export function tomorrowAtEight(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return unixSeconds(date);
}

export function nextMondayAtEight(): number {
  const date = new Date();
  const days = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + days);
  date.setHours(8, 0, 0, 0);
  return unixSeconds(date);
}

export function toLocalDateTimeInput(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

interface SnoozeMenuProps {
  disabled: boolean;
  onSnooze: (until: number) => void;
  onCustom: () => void;
}

export default function SnoozeMenu({
  disabled,
  onSnooze,
  onCustom,
}: SnoozeMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
        >
          <Clock3 className="h-3.5 w-3.5" />
          Snooze
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onSnooze(snoozeInHours(3))}>
          In 3 hours
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSnooze(tomorrowAtEight())}>
          Tomorrow at 08:00
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSnooze(nextMondayAtEight())}>
          Next Monday at 08:00
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCustom}>Custom…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
