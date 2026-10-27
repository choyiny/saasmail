import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CalendarClock, X } from "lucide-react";
import { snoozePresets } from "@/hooks/useMailList";
import { MenuItem, MenuSeparator } from "./Menu";
import { IconButton } from "./ui";

function presetTime(until: number): string {
  return new Date(until * 1000).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Snooze menu items (presets + "Choose a date"). */
export function SnoozeMenuItems({
  onPick,
  onCustom,
}: {
  onPick: (until: number) => void;
  onCustom: () => void;
}) {
  return (
    <>
      {snoozePresets().map((p) => (
        <MenuItem
          key={p.id}
          onSelect={() => onPick(p.until)}
          shortcut={presetTime(p.until)}
        >
          {p.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={<CalendarClock size={16} />} onSelect={onCustom}>
        Choose a date
      </MenuItem>
    </>
  );
}

function defaultLocal(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setHours(8, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Custom snooze date/time picker. */
export function SnoozeDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (until: number) => void;
}) {
  const [value, setValue] = useState(defaultLocal);
  const until = Math.floor(new Date(value).getTime() / 1000);
  const valid = Number.isFinite(until) && until * 1000 > Date.now();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (o) setValue(defaultLocal());
        onOpenChange(o);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ol-scrim" />
        <Dialog.Content className="ol-dialog w-[min(92vw,360px)]">
          <div className="flex items-center justify-between pb-2">
            <Dialog.Title className="text-[18px] font-semibold text-text-primary">
              Snooze until
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close">
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description className="pb-3 text-[13px] text-text-secondary">
            The conversation leaves your inbox and comes back at this time.
          </Dialog.Description>
          <input
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="ol-text-input w-full"
            aria-label="Snooze date and time"
          />
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="ol-btn-outline">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="ol-btn-primary"
              disabled={!valid}
              onClick={() => {
                onPick(until);
                onOpenChange(false);
              }}
            >
              Snooze
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
