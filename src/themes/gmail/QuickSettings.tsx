import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import type { ColorMode, UiTheme } from "@/lib/api";
import { usePreferences } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { UNDO_SEND_CHOICES } from "@/lib/undo-send";
import {
  useCommonSettings,
  useGmailView,
  type GmailDensity,
  type InboxType,
  type ReadingPane,
  type SwipeAction,
} from "./state";

function RadioRow({
  name,
  checked,
  onChange,
  children,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-4 py-1.5 text-sm">
      <input
        type="radio"
        name={name}
        className="gm-radio"
        checked={checked}
        onChange={onChange}
      />
      <span className="flex-1">
        {children}
        {hint && (
          <span className="block text-xs text-text-secondary">{hint}</span>
        )}
      </span>
    </label>
  );
}

/** Tiny pictures for the density / reading pane choices, like Gmail's. */
function Thumb({ kind }: { kind: string }) {
  const bar = "h-[3px] rounded-full bg-border-strong";
  return (
    <span
      aria-hidden
      className="flex h-8 w-11 flex-none flex-col justify-center gap-[3px] rounded-[4px] border border-border bg-bg-subtle p-1"
    >
      {kind === "right" ? (
        <span className="flex h-full gap-1">
          <span className="flex w-1/2 flex-col gap-[3px]">
            <span className={bar} />
            <span className={bar} />
            <span className={bar} />
          </span>
          <span className="w-1/2 rounded-[2px] bg-border" />
        </span>
      ) : kind === "below" ? (
        <>
          <span className={bar} />
          <span className={bar} />
          <span className="h-3 rounded-[2px] bg-border" />
        </>
      ) : (
        Array.from(
          { length: kind === "compact" ? 5 : kind === "comfortable" ? 3 : 4 },
          (_, i) => <span key={i} className={bar} />,
        )
      )}
    </span>
  );
}

const SWIPE_LABELS: Record<SwipeAction, string> = {
  archive: "Archive",
  delete: "Delete (to Trash)",
  read: "Mark as read/unread",
  snooze: "Snooze",
  none: "None",
};

/**
 * Gmail's Quick settings panel: the everyday view options one click from
 * the gear, with "See all settings" for the rest.
 */
export function QuickSettings({
  onClose,
  mobile,
}: {
  onClose: () => void;
  mobile?: boolean;
}) {
  const navigate = useNavigate();
  const prefs = usePreferences();
  const view = useGmailView();
  const [common, setCommon] = useCommonSettings();
  const density: GmailDensity =
    prefs.density === "compact" ? "compact" : view.density;

  const setDensity = (d: GmailDensity) => {
    if (d === "compact") {
      void prefs.setPreferences({ density: "compact" });
    } else {
      view.update({ density: d });
      if (prefs.density !== "comfortable")
        void prefs.setPreferences({ density: "comfortable" });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const section = "border-t border-border px-6 py-4";
  const heading =
    "mb-1 text-xs font-medium uppercase tracking-[0.08em] text-text-primary";
  const select =
    "h-9 rounded-[4px] border border-border-strong bg-card px-2 text-sm text-text-primary";

  return (
    <>
      <div
        className="gm-scrim"
        style={mobile ? undefined : { background: "transparent" }}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={cn("gm-side-drawer", mobile && "gm-side-drawer-full")}
        role="dialog"
        aria-modal="true"
        aria-label="Quick settings"
        data-testid="gmail-quick-settings"
      >
        <div className="flex h-16 items-center justify-between pl-6 pr-3">
          <h2 className="text-base font-medium">Quick settings</h2>
          <button
            type="button"
            className="gm-icon-btn"
            onClick={onClose}
            aria-label="Close quick settings"
            title="Close"
            autoFocus
          >
            <X size={20} />
          </button>
        </div>
        <div className="px-6 pb-4">
          <button
            type="button"
            onClick={() => {
              onClose();
              navigate("/settings");
            }}
            className="h-10 w-full rounded-full border border-border-strong text-sm font-medium text-accent hover:bg-accent-subtle"
          >
            See all settings
          </button>
        </div>

        {!mobile && (
          <div className={section}>
            <p className={heading}>Density</p>
            {(
              [
                ["default", "Default"],
                ["comfortable", "Comfortable"],
                ["compact", "Compact"],
              ] as Array<[GmailDensity, string]>
            ).map(([v, l]) => (
              <RadioRow
                key={v}
                name="gm-density"
                checked={density === v}
                onChange={() => setDensity(v)}
              >
                <span className="flex items-center justify-between gap-3">
                  {l}
                  <Thumb kind={v} />
                </span>
              </RadioRow>
            ))}
          </div>
        )}

        <div className={section}>
          <p className={heading}>Theme</p>
          {(
            [
              ["light", "Light"],
              ["dark", "Dark"],
              ["system", "Device default"],
            ] as Array<[ColorMode, string]>
          ).map(([v, l]) => (
            <RadioRow
              key={v}
              name="gm-theme"
              checked={prefs.colorMode === v}
              onChange={() => void prefs.setPreferences({ colorMode: v })}
            >
              {l}
            </RadioRow>
          ))}
        </div>

        <div className={section}>
          <p className={heading}>Inbox type</p>
          {(
            [
              ["default", "Default", "Newest first"],
              ["unread", "Unread first", "Unread conversations on top"],
              ["starred", "Starred first", "Starred conversations on top"],
            ] as Array<[InboxType, string, string]>
          ).map(([v, l, h]) => (
            <RadioRow
              key={v}
              name="gm-inbox-type"
              checked={view.inboxType === v}
              onChange={() => view.update({ inboxType: v })}
              hint={h}
            >
              {l}
            </RadioRow>
          ))}
          <label className="mt-2 flex cursor-pointer items-center gap-4 py-1.5 text-sm">
            <input
              type="checkbox"
              className="gm-check"
              checked={view.tabs}
              onChange={(e) => view.update({ tabs: e.target.checked })}
              data-testid="gmail-qs-tabs"
            />
            <span className="flex-1">
              Inbox tabs
              <span className="block text-xs text-text-secondary">
                Primary, Promotions, Social and Updates
              </span>
            </span>
          </label>
        </div>

        {!mobile && (
          <div className={section}>
            <p className={heading}>Reading pane</p>
            {(
              [
                ["none", "No split"],
                ["right", "Right of inbox"],
                ["below", "Below inbox"],
              ] as Array<[ReadingPane, string]>
            ).map(([v, l]) => (
              <RadioRow
                key={v}
                name="gm-pane"
                checked={view.readingPane === v}
                onChange={() => view.update({ readingPane: v })}
              >
                <span className="flex items-center justify-between gap-3">
                  {l}
                  <Thumb kind={v} />
                </span>
              </RadioRow>
            ))}
          </div>
        )}

        <div className={section}>
          <p className={heading}>Swipe actions (mobile)</p>
          {(
            [
              ["swipeRight", "Swipe right"],
              ["swipeLeft", "Swipe left"],
            ] as const
          ).map(([k, l]) => (
            <label
              key={k}
              className="flex items-center justify-between gap-4 py-1.5 text-sm"
            >
              {l}
              <select
                className={select}
                value={view[k]}
                onChange={(e) =>
                  view.update({ [k]: e.target.value as SwipeAction })
                }
                data-testid={`gmail-qs-${k}`}
              >
                {(Object.keys(SWIPE_LABELS) as SwipeAction[]).map((a) => (
                  <option key={a} value={a}>
                    {SWIPE_LABELS[a]}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <div className={section}>
          <p className={heading}>Undo send</p>
          <label className="flex items-center justify-between gap-4 py-1.5 text-sm">
            Send cancellation period
            <select
              className={select}
              value={common.undoSendSeconds}
              onChange={(e) =>
                setCommon({ undoSendSeconds: Number(e.target.value) })
              }
              data-testid="gmail-qs-undo-send"
            >
              {UNDO_SEND_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "Off" : `${n} seconds`}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={section}>
          <p className={heading}>Layout</p>
          {(
            [
              ["gmail", "Gmail"],
              ["outlook", "Outlook"],
              ["default", "Default"],
            ] as Array<[UiTheme, string]>
          ).map(([v, l]) => (
            <RadioRow
              key={v}
              name="gm-layout"
              checked={prefs.uiTheme === v}
              onChange={() => void prefs.setPreferences({ uiTheme: v })}
            >
              {l}
            </RadioRow>
          ))}
        </div>
      </aside>
    </>
  );
}
