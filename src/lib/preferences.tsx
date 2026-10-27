import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchPreferences,
  updatePreferences,
  type ColorMode,
  type Density,
  type Palette,
  type UiTheme,
  type UserPreferences,
} from "@/lib/api";
import { useSession } from "@/lib/auth-client";

/**
 * Per-user UI preferences: which mail client the inbox emulates (default,
 * Gmail, Outlook), the colour mode and list density.
 *
 * The account copy (GET/PATCH /api/user/preferences) is the source of
 * truth, so a choice follows the user across devices. localStorage holds a
 * mirror so the pre-paint script in index.html can set the attributes
 * before React mounts and nothing flashes in the wrong theme.
 *
 * The provider writes three attributes on <html>, which src/index.css keys
 * every token off: data-ui, data-mode (resolved light/dark) and
 * data-density.
 */

export const PREFS_STORAGE_KEY = "saasmail.preferences";
/**
 * `?ui=gmail|outlook|default` previews a theme in this tab only (kept in
 * sessionStorage) without changing the account setting. Picking a theme in
 * Settings clears it.
 */
export const UI_OVERRIDE_KEY = "saasmail.uiOverride";

function readOverride(): UiTheme | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("ui");
    if (fromUrl && (UI_THEMES as string[]).includes(fromUrl)) {
      window.sessionStorage.setItem(UI_OVERRIDE_KEY, fromUrl);
      return fromUrl as UiTheme;
    }
    const stored = window.sessionStorage.getItem(UI_OVERRIDE_KEY);
    return stored && (UI_THEMES as string[]).includes(stored)
      ? (stored as UiTheme)
      : null;
  } catch {
    return null;
  }
}

const DEFAULTS: UserPreferences = {
  uiTheme: "default",
  colorMode: "system",
  density: "comfortable",
  palette: "navy",
  layoutSettings: {},
  tabSeen: {},
};

export const PALETTES: Palette[] = [
  "navy",
  "ink",
  "slate",
  "indigo",
  "forest",
  "claret",
  "paper",
];

const UI_THEMES: UiTheme[] = ["default", "gmail", "outlook"];
const COLOR_MODES: ColorMode[] = ["light", "dark", "system"];
const DENSITIES: Density[] = ["comfortable", "compact"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function sanitize(raw: unknown): UserPreferences {
  const r = (raw ?? {}) as Partial<Record<keyof UserPreferences, unknown>>;
  return {
    uiTheme: UI_THEMES.includes(r.uiTheme as UiTheme)
      ? (r.uiTheme as UiTheme)
      : DEFAULTS.uiTheme,
    colorMode: COLOR_MODES.includes(r.colorMode as ColorMode)
      ? (r.colorMode as ColorMode)
      : DEFAULTS.colorMode,
    density: DENSITIES.includes(r.density as Density)
      ? (r.density as Density)
      : DEFAULTS.density,
    palette: PALETTES.includes(r.palette as Palette)
      ? (r.palette as Palette)
      : DEFAULTS.palette,
    layoutSettings: isPlainObject(r.layoutSettings)
      ? (r.layoutSettings as UserPreferences["layoutSettings"])
      : {},
    tabSeen: isPlainObject(r.tabSeen)
      ? (r.tabSeen as UserPreferences["tabSeen"])
      : {},
  };
}

function readStored(): UserPreferences {
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function writeStored(prefs: UserPreferences) {
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / storage disabled — the account copy still applies */
  }
}

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

export function resolveMode(mode: ColorMode): "light" | "dark" {
  if (mode === "system") return prefersDark() ? "dark" : "light";
  return mode;
}

/** Theme colour for the browser UI (address bar on mobile). */
function themeColorFor(
  ui: UiTheme,
  mode: "light" | "dark",
  palette: Palette,
): string {
  if (ui === "gmail") return mode === "dark" ? "#1b1b1b" : "#f6f8fc";
  if (ui === "outlook") return mode === "dark" ? "#0a2e4a" : "#0f6cbd";
  const chrome: Record<Palette, [string, string]> = {
    navy: ["#16203a", "#0b0e13"],
    ink: ["#101113", "#09090b"],
    slate: ["#1e242b", "#0d1116"],
    indigo: ["#241f52", "#12102a"],
    forest: ["#122a1f", "#08140f"],
    claret: ["#2c1419", "#150a0d"],
    paper: ["#dee2ea", "#16181d"],
  };
  return chrome[palette][mode === "dark" ? 1 : 0];
}

export function applyPreferencesToDocument(prefs: UserPreferences) {
  const root = document.documentElement;
  const mode = resolveMode(prefs.colorMode);
  root.dataset.ui = prefs.uiTheme;
  root.dataset.mode = mode;
  root.dataset.density = prefs.density;
  root.dataset.palette = prefs.palette;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta)
    meta.setAttribute(
      "content",
      themeColorFor(prefs.uiTheme, mode, prefs.palette),
    );
}

interface PreferencesContextValue extends UserPreferences {
  /** Resolved colour mode ("system" mapped to the OS setting). */
  resolvedMode: "light" | "dark";
  setPreferences: (patch: Partial<UserPreferences>) => Promise<void>;
  /** True once the account copy has loaded (or failed to). */
  loaded: boolean;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const [prefs, setPrefs] = useState<UserPreferences>(() =>
    typeof window === "undefined" ? DEFAULTS : readStored(),
  );
  const [loaded, setLoaded] = useState(false);
  const [systemDark, setSystemDark] = useState(prefersDark);
  const [override, setOverride] = useState<UiTheme | null>(() =>
    typeof window === "undefined" ? null : readOverride(),
  );
  const effective = useMemo<UserPreferences>(
    () => (override ? { ...prefs, uiTheme: override } : prefs),
    [prefs, override],
  );

  // Follow OS dark mode while the user is on "system".
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applyPreferencesToDocument(effective);
  }, [effective, systemDark]);

  // Load the account copy once signed in. Signed out (login, invite pages)
  // keeps whatever this device last used.
  const userId = session?.user?.id;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    fetchPreferences()
      .then((remote) => {
        if (cancelled) return;
        const next = sanitize(remote);
        setPrefs(next);
        writeStored(next);
      })
      .catch(() => {
        /* offline or older server — keep the local copy */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const setPreferences = useCallback(
    async (patch: Partial<UserPreferences>) => {
      if (patch.uiTheme) {
        try {
          window.sessionStorage.removeItem(UI_OVERRIDE_KEY);
        } catch {
          /* ignore */
        }
        setOverride(null);
      }
      // Optimistic: the theme switches at once, the server catches up.
      let next: UserPreferences = DEFAULTS;
      setPrefs((prev) => {
        next = sanitize({
          ...prev,
          ...patch,
          // Same merge as the server: by layout / by tab.
          layoutSettings: {
            ...prev.layoutSettings,
            ...(patch.layoutSettings ?? {}),
          },
          tabSeen: { ...prev.tabSeen, ...(patch.tabSeen ?? {}) },
        });
        writeStored(next);
        return next;
      });
      try {
        const saved = sanitize(await updatePreferences(patch));
        setPrefs(saved);
        writeStored(saved);
      } catch {
        /* keep the optimistic value; it is mirrored locally */
      }
    },
    [],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({
      ...effective,
      resolvedMode:
        effective.colorMode === "system"
          ? systemDark
            ? "dark"
            : "light"
          : effective.colorMode,
      setPreferences,
      loaded,
    }),
    [effective, systemDark, setPreferences, loaded],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    // Outside the provider (isolated component tests): behave as default.
    return {
      ...DEFAULTS,
      resolvedMode: "light",
      setPreferences: async () => {},
      loaded: true,
    };
  }
  return ctx;
}

export function useUiTheme(): UiTheme {
  return usePreferences().uiTheme;
}

/**
 * One layout's view settings (reading pane, swipe actions, favorites …),
 * saved to the account so they follow the user across devices.
 */
export function useLayoutSettings<T extends Record<string, unknown>>(
  layout: string,
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const { layoutSettings, setPreferences } = usePreferences();
  const saved = (layoutSettings[layout] ?? null) as Partial<T> | null;
  const value = useMemo(
    () => ({ ...defaults, ...(saved ?? {}) }) as T,
    [
      // eslint-disable-next-line react-hooks/exhaustive-deps
      JSON.stringify(saved),
    ],
  );
  const update = useCallback(
    (patch: Partial<T>) => {
      void setPreferences({
        layoutSettings: { [layout]: { ...value, ...patch } },
      });
    },
    [layout, value, setPreferences],
  );
  return [value, update];
}
