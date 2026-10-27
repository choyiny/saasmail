import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const DELAY_MS = 650;

/**
 * Fluent-style tooltips for the Outlook theme. Native `title` tooltips show
 * the moment the pointer happens to rest on a control (even on page load)
 * and look like the OS, not Outlook. This layer takes over `title` and
 * `data-tip` on Outlook surfaces: it shows only after the pointer has
 * actually moved and then hovered for a moment, never on keyboard focus,
 * and hides on click, key press or scroll.
 */
export default function Tooltips() {
  const [tip, setTip] = useState<{
    text: string;
    x: number;
    y: number;
    above: boolean;
  } | null>(null);

  useEffect(() => {
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;

    const hide = () => {
      current = null;
      clearTimeout(timer);
      setTip(null);
    };
    const arm = () => {
      armed = true;
    };
    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      const above = r.bottom + 40 > window.innerHeight;
      setTip({
        text,
        x: Math.min(window.innerWidth - 12, Math.max(12, r.left + r.width / 2)),
        y: above ? r.top - 6 : r.bottom + 6,
        above,
      });
    };
    const onOver = (e: PointerEvent) => {
      if (!armed || e.pointerType === "touch") return;
      const target = e.target as Element | null;
      const el = target?.closest?.("[title], [data-tip]") as HTMLElement | null;
      if (!el || el === current) return;
      if (!el.closest(".ol-root, .ol-menu, .ol-dialog, .ol-settings-panel"))
        return;
      const title = el.getAttribute("title");
      if (title !== null) {
        if (title) {
          el.dataset.tip = title;
          if (!el.getAttribute("aria-label") && !el.textContent?.trim())
            el.setAttribute("aria-label", title);
        }
        el.removeAttribute("title");
      }
      current = el;
      clearTimeout(timer);
      setTip(null);
      timer = setTimeout(() => show(el), DELAY_MS);
    };
    const onOut = (e: PointerEvent) => {
      if (!current) return;
      const to = e.relatedTarget as Node | null;
      if (to && current.contains(to)) return;
      hide();
    };

    window.addEventListener("pointermove", arm, { once: true });
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", arm);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div
      role="tooltip"
      className="ol-tooltip"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(-50%, ${tip.above ? "-100%" : "0"})`,
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
