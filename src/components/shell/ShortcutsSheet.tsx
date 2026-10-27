import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Keyboard, X } from "lucide-react";
import { SHORTCUT_GROUPS } from "@/lib/shortcuts";
import { shellStore, useShell } from "./shellStore";

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|ad)/.test(navigator.platform);

/** The "?" sheet: every keyboard shortcut in the default layout. */
export default function ShortcutsSheet() {
  const open = useShell((s) => s.keys);
  if (!open) return null;
  return createPortal(<Sheet />, document.body);
}

function Sheet() {
  const ref = useRef<HTMLDivElement>(null);
  const close = () => shellStore.set({ keys: false });

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);

  return (
    <>
      <div className="pt-cmd-scrim" onClick={close} />
      <div
        ref={ref}
        tabIndex={-1}
        className="pt-cmd pt-keys"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pt-keys-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "?") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        <div className="pt-keys-head">
          <Keyboard size={16} aria-hidden />
          <h2 id="pt-keys-title">Keyboard shortcuts</h2>
          <button
            type="button"
            className="pt-keys-x"
            onClick={close}
            aria-label="Close shortcuts"
          >
            <X size={15} />
          </button>
        </div>
        <div className="pt-keys-body">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h3 className="pt-cmd-group">{g.title}</h3>
              <dl>
                {g.items.map((it) => (
                  <div key={it.label} className="pt-keys-row">
                    <dt>{it.label}</dt>
                    <dd>
                      {it.keys.map((k, i) => (
                        <kbd key={i}>{k === "⌘" && !isMac ? "Ctrl" : k}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="pt-cmd-foot">
          <span>
            Shortcuts work in the inbox when you are not typing. Press{" "}
            <kbd>?</kbd> any time to see this list.
          </span>
        </div>
      </div>
    </>
  );
}
