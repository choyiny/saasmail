import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

interface Branding {
  passkeyRequired: boolean;
  brandName: string;
  webmcpEnabled: boolean;
  /** An admin paused outbound sending: sends are queued until it resumes. */
  outboundPaused: boolean;
}

const DEFAULT_BRANDING: Branding = {
  passkeyRequired: true,
  brandName: "saasmail",
  webmcpEnabled: true,
  outboundPaused: false,
};

interface BrandingContextValue extends Branding {
  loaded: boolean;
  /**
   * Re-fetch /api/config so callers (e.g. the admin "App branding" form) can
   * push a freshly-saved value into the live UI without a hard reload.
   */
  refresh: () => Promise<void>;
}

/** How often an open tab re-reads the config, mainly for the sending pause. */
const CONFIG_REFRESH_MS = 60_000;

function sameBranding(a: Branding, b: Branding): boolean {
  return (
    a.passkeyRequired === b.passkeyRequired &&
    a.brandName === b.brandName &&
    a.webmcpEnabled === b.webmcpEnabled &&
    a.outboundPaused === b.outboundPaused
  );
}

const BrandingContext = createContext<BrandingContextValue>({
  ...DEFAULT_BRANDING,
  loaded: false,
  refresh: async () => {},
});

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const [branding, setBranding] = useState<Branding & { loaded: boolean }>({
    ...DEFAULT_BRANDING,
    loaded: false,
  });

  const lastRefresh = useRef(0);

  const refresh = useCallback(async () => {
    lastRefresh.current = Date.now();
    try {
      const res = await fetch("/api/config");
      const b = (await res.json()) as Partial<Branding>;
      const next = {
        passkeyRequired:
          typeof b.passkeyRequired === "boolean"
            ? b.passkeyRequired
            : DEFAULT_BRANDING.passkeyRequired,
        brandName:
          typeof b.brandName === "string" && b.brandName.length > 0
            ? b.brandName
            : DEFAULT_BRANDING.brandName,
        webmcpEnabled:
          typeof b.webmcpEnabled === "boolean"
            ? b.webmcpEnabled
            : DEFAULT_BRANDING.webmcpEnabled,
        outboundPaused: b.outboundPaused === true,
        loaded: true,
      };
      // Unchanged: keep the same object, so a periodic re-read re-renders
      // nothing.
      setBranding((prev) =>
        prev.loaded && sameBranding(prev, next) ? prev : next,
      );
    } catch {
      setBranding((prev) => ({ ...prev, loaded: true }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Another admin may pause or resume sending while this tab is open: re-read
  // when the tab comes back into view, and every minute while it is visible.
  useEffect(() => {
    function refreshIfStale() {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefresh.current < 5_000) return;
      void refresh();
    }
    const timer = window.setInterval(refreshIfStale, CONFIG_REFRESH_MS);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [refresh]);

  return (
    <BrandingContext.Provider value={{ ...branding, refresh }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}
