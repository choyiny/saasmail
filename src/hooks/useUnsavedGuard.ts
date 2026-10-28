import { useCallback, useContext, useEffect, useRef } from "react";
import { UNSAFE_NavigationContext } from "react-router-dom";

const MESSAGE = "You have unsaved changes. Leave without saving?";

type HistoryNavigator = {
  push: (...args: never[]) => void;
  replace: (...args: never[]) => void;
};

/**
 * Warn before unsaved edits are lost: on reload or tab close (the
 * browser's own prompt), and on any in-app navigation (a confirm).
 *
 * The app uses BrowserRouter, which has no `useBlocker` (that needs a data
 * router), so the guard wraps the router's navigator instead. Every
 * in-app navigation goes through `navigator.push`/`replace` — `<Link>`
 * clicks and programmatic `navigate()` alike (command palette, "g"
 * chords, account menu, notifications) — so one wrapper covers all of
 * them. Browser Back/Forward (popstate) is not interceptable here.
 *
 * Returns `confirmLeave()` for the page's own Cancel/Back buttons, and
 * `release()` to call right before navigating away after a save.
 */
export function useUnsavedGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const released = useRef(false);
  const { navigator } = useContext(UNSAFE_NavigationContext);

  const shouldBlock = () => dirtyRef.current && !released.current;

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!shouldBlock()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    const nav = navigator as unknown as HistoryNavigator;
    const push = nav.push;
    const replace = nav.replace;
    const guard =
      (fn: (...args: never[]) => void) =>
      (...args: never[]) => {
        if (shouldBlock()) {
          if (!window.confirm(MESSAGE)) return;
          released.current = true;
        }
        fn.apply(nav, args);
      };
    nav.push = guard(push);
    nav.replace = guard(replace);
    return () => {
      nav.push = push;
      nav.replace = replace;
    };
  }, [navigator]);

  const confirmLeave = useCallback(() => {
    if (!shouldBlock()) return true;
    if (!window.confirm(MESSAGE)) return false;
    // The user chose to leave: don't ask again when the caller navigates.
    released.current = true;
    return true;
  }, []);
  const release = useCallback(() => {
    released.current = true;
  }, []);

  return { confirmLeave, release };
}
