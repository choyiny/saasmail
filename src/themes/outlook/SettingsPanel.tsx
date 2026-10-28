import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Monitor, Moon, Sun, X } from "lucide-react";
import { usePreferences } from "@/lib/preferences";
import type { UiTheme } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  ALL_QUICK_ACTIONS,
  useOutlook,
  type QuickAction,
  type ReadingPanePos,
} from "./context";
import { SWIPE_LABELS, type SwipeAction } from "./lib";
import { UNDO_SEND_CHOICES } from "@/lib/undo-send";
import { useUndoSendSetting } from "./sendUndo";

const QUICK_LABELS: Record<QuickAction, string> = {
  delete: "Delete",
  archive: "Archive",
  flag: "Flag / Clear flag",
  pin: "Pin / Unpin",
  read: "Mark as read / unread",
};
import { IconButton } from "./ui";

function Radio<T extends string>({
  name,
  value,
  current,
  onChange,
  children,
}: {
  name: string;
  value: T;
  current: T;
  onChange: (v: T) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="ol-radio">
      <input
        type="radio"
        name={name}
        value={value}
        checked={current === value}
        onChange={() => onChange(value)}
      />
      <span className="ol-radio-dot" aria-hidden />
      <span>{children}</span>
    </label>
  );
}

/**
 * The "Settings" flyout from the gear in the suite header (new Outlook's
 * quick settings): theme, density, conversation view, reading pane and
 * which mail layout to use, with a link to the full settings page.
 */
export function SettingsBody({ onDone }: { onDone?: () => void }) {
  const navigate = useNavigate();
  const { colorMode, density, uiTheme, setPreferences } = usePreferences();
  const o = useOutlook();
  const [common, setCommon] = useUndoSendSetting();
  const { readingPane, conversationView, spacious, setLayout } = o;
  const densityValue =
    density === "compact" ? "compact" : spacious ? "spacious" : "cozy";

  return (
    <div className="flex flex-col gap-6 px-5 pb-6 pt-2">
      <section>
        <h3 className="ol-settings-h">Theme</h3>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { v: "light", label: "Light", Icon: Sun },
              { v: "dark", label: "Dark", Icon: Moon },
              { v: "system", label: "System", Icon: Monitor },
            ] as const
          ).map(({ v, label, Icon }) => (
            <button
              key={v}
              type="button"
              aria-pressed={colorMode === v}
              onClick={() => void setPreferences({ colorMode: v })}
              className={cn(
                "ol-theme-tile",
                colorMode === v && "ol-theme-tile-on",
              )}
            >
              <span className={cn("ol-theme-swatch", `ol-theme-swatch-${v}`)}>
                <Icon size={16} aria-hidden />
              </span>
              {label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="ol-settings-h">Density</h3>
        <div className="flex flex-col gap-1">
          <Radio
            name="ol-density"
            value="spacious"
            current={densityValue}
            onChange={() => {
              setLayout({ spacious: true });
              void setPreferences({ density: "comfortable" });
            }}
          >
            Spacious
          </Radio>
          <Radio
            name="ol-density"
            value="cozy"
            current={densityValue}
            onChange={() => {
              setLayout({ spacious: false });
              void setPreferences({ density: "comfortable" });
            }}
          >
            Cozy
          </Radio>
          <Radio
            name="ol-density"
            value="compact"
            current={densityValue}
            onChange={() => {
              setLayout({ spacious: false });
              void setPreferences({ density: "compact" });
            }}
          >
            Compact
          </Radio>
        </div>
      </section>

      <section>
        <h3 className="ol-settings-h">Conversation view</h3>
        <div className="flex flex-col gap-1">
          <Radio
            name="ol-conv"
            value="on"
            current={conversationView ? "on" : "off"}
            onChange={() => setLayout({ conversationView: true })}
          >
            Show all messages in a conversation
          </Radio>
          <Radio
            name="ol-conv"
            value="off"
            current={conversationView ? "on" : "off"}
            onChange={() => setLayout({ conversationView: false })}
          >
            Show only the latest message
          </Radio>
        </div>
      </section>

      <section>
        <h3 className="ol-settings-h">Undo send</h3>
        <label className="ol-field-row">
          <span>Cancel sending within</span>
          <select
            className="ol-select"
            value={common.undoSendSeconds}
            aria-label="Undo send delay"
            onChange={(e) =>
              setCommon({ undoSendSeconds: Number(e.target.value) })
            }
          >
            {UNDO_SEND_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "Off" : `${n} seconds`}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section>
        <h3 className="ol-settings-h">Focused Inbox</h3>
        <label className="ol-switch">
          <input
            type="checkbox"
            role="switch"
            checked={o.focusedInbox}
            onChange={(e) => setLayout({ focusedInbox: e.target.checked })}
          />
          <span className="ol-switch-track" aria-hidden />
          <span>Sort messages into Focused and Other</span>
        </label>
      </section>

      {!o.isMobile && (
        <section>
          <h3 className="ol-settings-h">Quick actions</h3>
          <p className="mb-2 text-[12px] text-text-secondary">
            Shown when you point at a message in the list.
          </p>
          <div className="flex flex-col gap-1">
            {ALL_QUICK_ACTIONS.map((a) => (
              <label key={a} className="ol-check">
                <input
                  type="checkbox"
                  checked={o.quickActions.includes(a)}
                  onChange={(e) =>
                    setLayout({
                      quickActions: e.target.checked
                        ? ALL_QUICK_ACTIONS.filter(
                            (x) => x === a || o.quickActions.includes(x),
                          )
                        : o.quickActions.filter((x) => x !== a),
                    })
                  }
                />
                <span>{QUICK_LABELS[a]}</span>
              </label>
            ))}
          </div>
        </section>
      )}

      {o.isMobile && (
        <section>
          <h3 className="ol-settings-h">Swipe options</h3>
          {(
            [
              ["swipeRight", "Swipe right"],
              ["swipeLeft", "Swipe left"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="ol-field-row">
              <span>{label}</span>
              <select
                value={o[k]}
                onChange={(e) =>
                  setLayout({ [k]: e.target.value as SwipeAction })
                }
                className="ol-select"
                aria-label={label}
              >
                {(Object.keys(SWIPE_LABELS) as SwipeAction[]).map((v) => (
                  <option key={v} value={v}>
                    {SWIPE_LABELS[v]}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </section>
      )}

      <section className="max-md:hidden">
        <h3 className="ol-settings-h">Reading pane</h3>
        <div className="flex flex-col gap-1">
          {(
            [
              ["right", "Show on the right"],
              ["bottom", "Show on the bottom"],
              ["off", "Hide"],
            ] as Array<[ReadingPanePos, string]>
          ).map(([v, label]) => (
            <Radio
              key={v}
              name="ol-pane"
              value={v}
              current={readingPane}
              onChange={(next) => setLayout({ readingPane: next })}
            >
              {label}
            </Radio>
          ))}
        </div>
      </section>

      <section>
        <h3 className="ol-settings-h">Layout</h3>
        <div className="flex flex-col gap-1">
          {(
            [
              ["default", "Default"],
              ["gmail", "Gmail"],
              ["outlook", "Outlook"],
            ] as Array<[UiTheme, string]>
          ).map(([v, label]) => (
            <Radio
              key={v}
              name="ol-ui"
              value={v}
              current={uiTheme}
              onChange={(next) => void setPreferences({ uiTheme: next })}
            >
              {label}
            </Radio>
          ))}
        </div>
      </section>

      <button
        type="button"
        className="ol-link inline-flex items-center gap-1.5 self-start text-[14px]"
        onClick={() => {
          onDone?.();
          navigate("/settings");
        }}
      >
        View all settings
        <ExternalLink size={14} aria-hidden />
      </button>
    </div>
  );
}

export default function SettingsPanel() {
  const { settingsOpen, setSettingsOpen } = useOutlook();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, setSettingsOpen]);

  if (!settingsOpen) return null;
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="Settings"
      className="ol-settings-panel"
    >
      <div className="flex h-12 items-center justify-between pl-5 pr-2">
        <h2 className="text-[16px] font-semibold text-text-primary">
          Settings
        </h2>
        <IconButton
          label="Close settings"
          onClick={() => setSettingsOpen(false)}
        >
          <X size={18} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SettingsBody onDone={() => setSettingsOpen(false)} />
      </div>
    </aside>
  );
}
