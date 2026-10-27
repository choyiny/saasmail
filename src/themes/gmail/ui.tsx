import { useEffect, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { Clock, CalendarClock, X } from "lucide-react";
import { snoozePresets } from "@/hooks/useMailList";
import { cn } from "@/lib/utils";
import { colorIndex, initialOf, labelName, SHORTCUT_HELP } from "./lib";

/* ── Avatar & label chip ───────────────────────────────────────────── */

export function Avatar({
  name,
  email,
  size = 40,
  className,
}: {
  name: string | null | undefined;
  email?: string;
  size?: number;
  className?: string;
}) {
  const key = (email || name || "?").toLowerCase();
  return (
    <span
      aria-hidden
      className={cn("gm-avatar", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        background: `var(--gm-avatar-${colorIndex(key)})`,
      }}
    >
      {initialOf(name, email)}
    </span>
  );
}

export function LabelChip({
  address,
  displayName,
  onClick,
}: {
  address: string;
  displayName?: string | null;
  onClick?: () => void;
}) {
  const i = colorIndex(address.toLowerCase());
  return (
    <span
      className={cn("gm-chip flex-none", onClick && "cursor-pointer")}
      title={address}
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      style={{
        background: `var(--gm-label-bg-${i})`,
        color: `var(--gm-label-fg-${i})`,
      }}
    >
      {labelName(address, displayName)}
    </span>
  );
}

export function LabelDot({ address }: { address: string }) {
  return (
    <span
      aria-hidden
      className="gm-label-dot flex-none"
      style={{
        background: `var(--gm-dot-${colorIndex(address.toLowerCase())})`,
      }}
    />
  );
}

/* ── Menus ─────────────────────────────────────────────────────────── */

export function GmMenu({
  trigger,
  children,
  align = "start",
  side,
  modal,
  open,
  onOpenChange,
  testId,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end" | "center";
  side?: "top" | "bottom" | "left" | "right";
  modal?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId?: string;
}) {
  return (
    <Menu.Root modal={modal} open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="gm-menu"
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={8}
          data-testid={testId}
        >
          {children}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function GmMenuItem({
  icon,
  children,
  onSelect,
  disabled,
  trailing,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <Menu.Item className="gm-menu-item" onSelect={onSelect} disabled={disabled}>
      {icon}
      <span className="flex-1">{children}</span>
      {trailing}
    </Menu.Item>
  );
}

export const GmMenuSep = () => <Menu.Separator className="gm-menu-sep" />;
export const GmMenuLabel = ({ children }: { children: ReactNode }) => (
  <Menu.Label className="gm-menu-label">{children}</Menu.Label>
);

/* ── Snooze ────────────────────────────────────────────────────────── */

function presetStamp(until: number) {
  const d = new Date(until * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      });
}

/** Gmail's "Snooze until…" menu. */
export function SnoozeMenu({
  trigger,
  onSnooze,
  onPick,
  align = "start",
}: {
  trigger: ReactNode;
  onSnooze: (until: number) => void;
  onPick: () => void;
  align?: "start" | "end";
}) {
  return (
    <GmMenu trigger={trigger} align={align}>
      <GmMenuLabel>Snooze until…</GmMenuLabel>
      {snoozePresets().map((p) => (
        <GmMenuItem
          key={p.id}
          onSelect={() => onSnooze(p.until)}
          trailing={
            <span className="text-[13px] text-text-secondary">
              {presetStamp(p.until)}
            </span>
          }
        >
          {p.label}
        </GmMenuItem>
      ))}
      <GmMenuSep />
      <GmMenuItem icon={<CalendarClock size={20} />} onSelect={onPick}>
        Pick date & time
      </GmMenuItem>
    </GmMenu>
  );
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** "Pick date & time" dialog; returns unix seconds. */
export function PickDateDialog({
  open,
  onClose,
  onPick,
  presets,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (until: number) => void;
  /** Also list the quick presets (mobile and the `b` shortcut). */
  presets?: boolean;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (open) {
      const d = new Date(Date.now() + 24 * 3600 * 1000);
      d.setHours(8, 0, 0, 0);
      setValue(toLocalInput(d));
    }
  }, [open]);
  const ts = value ? Math.floor(new Date(value).getTime() / 1000) : 0;
  const valid = ts > Date.now() / 1000;
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="gm-scrim" style={{ zIndex: 79 }} />
        <Dialog.Content className="gm-dialog w-[360px] p-6">
          <Dialog.Title className="mb-4 flex items-center gap-2 text-[22px] font-normal">
            <Clock size={22} className="text-text-secondary" />
            {presets ? "Snooze until…" : "Pick date & time"}
          </Dialog.Title>
          {presets && (
            <div className="-mx-6 mb-4 flex flex-col">
              {snoozePresets().map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onPick(p.until);
                    onClose();
                  }}
                  className="flex h-12 items-center justify-between px-6 text-left text-sm outline-none hover:bg-bg-muted focus-visible:bg-bg-muted"
                >
                  <span>{p.label}</span>
                  <span className="text-text-secondary">
                    {presetStamp(p.until)}
                  </span>
                </button>
              ))}
              <p className="px-6 pt-3 text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
                Pick date & time
              </p>
            </div>
          )}
          <Dialog.Description className="sr-only">
            Choose when this conversation comes back to the inbox.
          </Dialog.Description>
          <input
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-12 w-full rounded-[4px] border border-border-strong bg-transparent px-3 text-[16px] text-text-primary outline-none focus:border-accent"
            aria-label="Snooze until"
          />
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-full px-4 text-sm font-medium text-accent hover:bg-accent-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!valid}
              onClick={() => {
                onPick(ts);
                onClose();
              }}
              className="h-10 rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── Confirm ───────────────────────────────────────────────────────── */

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="gm-scrim" style={{ zIndex: 79 }} />
        <Dialog.Content
          className="gm-dialog w-[400px] p-6"
          data-testid="gmail-confirm"
        >
          <Dialog.Title className="mb-3 text-[22px] font-normal">
            {title}
          </Dialog.Title>
          <Dialog.Description className="text-sm leading-relaxed text-text-secondary">
            {body}
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-full px-4 text-sm font-medium text-accent hover:bg-accent-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => {
                onConfirm();
                onClose();
              }}
              className="h-10 rounded-full px-4 text-sm font-medium text-destructive hover:bg-destructive-subtle"
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── Keyboard shortcut help ────────────────────────────────────────── */

export function ShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="gm-scrim" style={{ zIndex: 79 }} />
        <Dialog.Content className="gm-dialog w-[760px] p-6">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-[22px] font-normal">
              Keyboard shortcuts
            </Dialog.Title>
            <Dialog.Close className="gm-icon-btn" aria-label="Close">
              <X size={20} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Single-key shortcuts available in the mail list and conversation.
          </Dialog.Description>
          <div className="grid grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-2">
            {SHORTCUT_HELP.map((g) => (
              <section key={g.group}>
                <h3 className="mb-2 text-sm font-medium text-text-primary">
                  {g.group}
                </h3>
                <dl className="space-y-1.5">
                  {g.items.map((s) => (
                    <div
                      key={s.keys}
                      className="flex items-center justify-between gap-4 text-sm"
                    >
                      <dt className="text-text-secondary">{s.label}</dt>
                      <dd className="flex-none">
                        <kbd className="gm-kbd">{s.keys}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
