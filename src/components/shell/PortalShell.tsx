import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Rail from "./Rail";
import TopBand from "./TopBand";
import CommandPalette from "./CommandPalette";
import ShortcutsSheet from "./ShortcutsSheet";
import { shellStore } from "./shellStore";
import { MAIL_VIEWS, mailViewHref } from "./nav";
import { goChord, shouldIgnoreKey } from "@/lib/shortcuts";

/** Second key of a "g" chord → mail view id. */
const GO_TO: Record<string, string> = {
  i: "inbox",
  s: "starred",
  b: "snoozed",
  t: "sent",
  d: "drafts",
  a: "archive",
  q: "sequenced",
};

function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(q).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

/**
 * The default theme's frame: navy chrome (rail + top band) around one
 * rounded light "paper" panel that scrolls. Below 900px the rail becomes an
 * off-canvas drawer and the paper goes edge to edge.
 */
export default function PortalShell({
  children,
  onCompose,
}: {
  children: ReactNode;
  onCompose: () => void;
}) {
  const drawer = useMediaQuery("(max-width: 900px)");
  const [navOpen, setNavOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const onComposeRef = useRef(onCompose);
  onComposeRef.current = onCompose;

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);

  // ⌘K / Ctrl+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        shellStore.set({ cmdk: !shellStore.get().cmdk });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // App-wide single keys: "?" shortcuts, "c" compose, "/" search, and
  // "g" then a letter to jump to a mail view. The inbox adds its own
  // (j/k, e, s…) in InboxPage.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKey(e)) return;
      const s = shellStore.get();
      if (s.cmdk || s.keys) return;
      if (goChord.pending()) {
        // The key after "g" is always the chord's, even when it isn't a
        // view: consume it so the inbox's triage keys never see it.
        goChord.end();
        e.preventDefault();
        const view = MAIL_VIEWS.find((v) => v.id === GO_TO[e.key]);
        if (view) navigate(mailViewHref(view));
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        shellStore.set({ keys: true });
      } else if (e.key === "g") {
        goChord.start();
      } else if (e.key === "c") {
        e.preventDefault();
        onComposeRef.current();
      } else if (e.key === "/") {
        e.preventDefault();
        const search = document.querySelector<HTMLInputElement>(
          '[data-testid="person-search-input"]',
        );
        if (search) {
          search.focus();
          search.select();
        } else shellStore.set({ cmdk: true });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <div className={`pt-app${drawer && navOpen ? " nav-open" : ""}`}>
      <a
        href="#pt-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[70] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-text-primary"
      >
        Skip to content
      </a>
      <div className="pt-scrim" onClick={() => setNavOpen(false)} />
      <Rail drawer={drawer} />
      <div className="pt-col">
        <TopBand onMenu={() => setNavOpen(true)} onCompose={onCompose} />
        <main id="pt-main" className="pt-paper" tabIndex={-1}>
          <div className="pt-scroll" ref={scroller}>
            {children}
          </div>
        </main>
      </div>
      <CommandPalette onCompose={onCompose} />
      <ShortcutsSheet />
    </div>
  );
}
