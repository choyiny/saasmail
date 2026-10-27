import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Archive,
  Brush,
  Clock,
  Inbox as InboxIcon,
  Trash2,
  X,
} from "lucide-react";
import { fetchGroupedPeople, type GroupedItem } from "@/lib/api";
import { cn } from "@/lib/utils";
import { senderAddresses, sweepSelection } from "./lib";
import { SnoozeDialog } from "./Snooze";
import type { MoveTarget, OutlookMail } from "./useOutlookMail";
import { FlagGlyph, IconButton } from "./ui";

/**
 * Dialogs shared by the ribbon, context menus, drag and drop and keyboard
 * shortcuts: Snooze (custom date), Move to folder (Ctrl+Shift+V) and Sweep.
 */
interface MailUi {
  requestSnooze: (items: GroupedItem[]) => void;
  requestMove: (items: GroupedItem[]) => void;
  requestSweep: (items: GroupedItem[]) => void;
}

const Ctx = createContext<MailUi | null>(null);

export function useMailUi(): MailUi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useMailUi outside MailUiProvider");
  return c;
}

const MOVE_TARGETS: Array<{
  id: MoveTarget;
  label: string;
  icon: ReactNode;
  hint?: string;
}> = [
  { id: "inbox", label: "Inbox", icon: <InboxIcon size={18} /> },
  { id: "archive", label: "Archive", icon: <Archive size={18} /> },
  {
    id: "snoozed",
    label: "Snoozed",
    icon: <Clock size={18} />,
    hint: "Pick a time",
  },
  { id: "flagged", label: "Flagged", icon: <FlagGlyph size={18} /> },
  {
    id: "deleted",
    label: "Deleted Items",
    icon: <Trash2 size={18} />,
  },
];

function MoveDialog({
  items,
  onClose,
  onPick,
}: {
  items: GroupedItem[] | null;
  onClose: () => void;
  onPick: (t: MoveTarget) => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const shown = MOVE_TARGETS.filter((t) =>
    t.label.toLowerCase().includes(q.trim().toLowerCase()),
  );
  useEffect(() => {
    setQ("");
    setActive(0);
  }, [items]);
  return (
    <Dialog.Root open={!!items} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="ol-scrim" />
        <Dialog.Content className="ol-dialog w-[min(92vw,380px)]">
          <div className="flex items-center justify-between pb-2">
            <Dialog.Title className="text-[18px] font-semibold text-text-primary">
              Move{" "}
              {items && items.length > 1 ? `${items.length} items` : "item"} to
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close">
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Pick a folder. Type to filter, use the arrow keys and Enter.
          </Dialog.Description>
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(shown.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter" && shown[active]) {
                e.preventDefault();
                onPick(shown[active].id);
              }
            }}
            placeholder="Search for a folder"
            aria-label="Search for a folder"
            className="ol-text-input mb-2 w-full"
          />
          <div role="listbox" aria-label="Folders" className="flex flex-col">
            {shown.map((t, i) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(t.id)}
                className={cn("ol-folder", i === active && "ol-folder-on")}
              >
                <span className="ol-folder-icon">{t.icon}</span>
                <span className="flex-1 text-left">{t.label}</span>
                {t.hint && (
                  <span className="text-[12px] text-text-secondary">
                    {t.hint}
                  </span>
                )}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SweepDialog({
  mail,
  seed,
  onClose,
}: {
  mail: OutlookMail;
  seed: GroupedItem[] | null;
  onClose: () => void;
}) {
  const [sender, setSender] = useState("");
  const [action, setAction] = useState<"archive" | "delete">("archive");
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const senders = useMemo(() => {
    const s = new Set<string>();
    for (const it of mail.allItems)
      for (const a of senderAddresses(it)) s.add(a);
    return [...s].slice(0, 200);
  }, [mail.allItems]);

  useEffect(() => {
    if (!seed) return;
    const first = seed.find((i) => i.type === "person");
    setSender(first ? first.email.toLowerCase() : "");
    setAction("archive");
  }, [seed]);

  // Live count of what Sweep will touch.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!seed || !sender.trim()) {
      setCount(null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    let cancelled = false;
    timer.current = setTimeout(() => {
      fetchGroupedPeople({
        folder: "inbox",
        recipient: mail.label,
        from: sender.trim().replace(/^@/, ""),
        limit: 100,
      })
        .then(
          (r) => !cancelled && setCount(sweepSelection(r.data, sender).length),
        )
        .catch(() => !cancelled && setCount(null));
    }, 250);
    return () => {
      cancelled = true;
    };
  }, [sender, seed, mail.label]);

  return (
    <Dialog.Root open={!!seed} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="ol-scrim" />
        <Dialog.Content className="ol-dialog w-[min(92vw,460px)]">
          <div className="flex items-center justify-between pb-2">
            <Dialog.Title className="flex items-center gap-2 text-[18px] font-semibold text-text-primary">
              <Brush size={18} className="text-accent" aria-hidden /> Sweep
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close">
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description className="pb-3 text-[13px] text-text-secondary">
            Quickly clear out the Inbox: everything from one sender (or a whole
            domain such as @example.com).
          </Dialog.Description>
          <label
            className="mb-1 block text-[13px] font-semibold text-text-primary"
            htmlFor="ol-sweep-sender"
          >
            Messages from
          </label>
          <input
            id="ol-sweep-sender"
            list="ol-sweep-senders"
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            placeholder="name@example.com or @example.com"
            className="ol-text-input w-full"
            autoFocus
          />
          <datalist id="ol-sweep-senders">
            {senders.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <p
            className="mt-1 h-5 text-[12px] text-text-secondary"
            aria-live="polite"
          >
            {count === null
              ? ""
              : count === 0
                ? "Nothing in the Inbox from this sender"
                : `${count} conversation${count === 1 ? "" : "s"} in the Inbox`}
          </p>
          <fieldset className="mt-2 flex flex-col gap-1">
            <legend className="sr-only">What to do</legend>
            <label className="ol-radio">
              <input
                type="radio"
                name="ol-sweep"
                checked={action === "archive"}
                onChange={() => setAction("archive")}
              />
              <span className="ol-radio-dot" aria-hidden />
              <span>Move all messages from the Inbox to Archive</span>
            </label>
            <label className="ol-radio">
              <input
                type="radio"
                name="ol-sweep"
                checked={action === "delete"}
                onChange={() => setAction("delete")}
              />
              <span className="ol-radio-dot" aria-hidden />
              <span>Move all messages from the Inbox to Deleted Items</span>
            </label>
          </fieldset>
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="ol-btn-outline">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="ol-btn-primary"
              disabled={!sender.trim() || busy || count === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  await mail.ops.sweep(sender.trim(), action);
                  onClose();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Sweep
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function MailUiProvider({
  mail,
  children,
}: {
  mail: OutlookMail;
  children: ReactNode;
}) {
  const [snoozeItems, setSnoozeItems] = useState<GroupedItem[] | null>(null);
  const [moveItems, setMoveItems] = useState<GroupedItem[] | null>(null);
  const [sweepSeed, setSweepSeed] = useState<GroupedItem[] | null>(null);
  const value = useMemo<MailUi>(
    () => ({
      requestSnooze: (items) => items.length && setSnoozeItems(items),
      requestMove: (items) => items.length && setMoveItems(items),
      requestSweep: (items) => setSweepSeed(items),
    }),
    [],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <SnoozeDialog
        open={!!snoozeItems}
        onOpenChange={(o) => !o && setSnoozeItems(null)}
        onPick={(u) => {
          if (snoozeItems) mail.ops.snooze(snoozeItems, u);
          setSnoozeItems(null);
        }}
      />
      <MoveDialog
        items={moveItems}
        onClose={() => setMoveItems(null)}
        onPick={(t) => {
          const items = moveItems ?? [];
          setMoveItems(null);
          if (t === "snoozed") setSnoozeItems(items);
          else mail.ops.moveTo(items, t);
        }}
      />
      <SweepDialog
        mail={mail}
        seed={sweepSeed}
        onClose={() => setSweepSeed(null)}
      />
    </Ctx.Provider>
  );
}
