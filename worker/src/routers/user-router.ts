import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { passkeys } from "../db/auth.schema";
import { userPreferences } from "../db/user-preferences.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const userRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const PasskeyStatusSchema = z.object({
  hasPasskey: z.boolean(),
});

const passkeyStatusRoute = createRoute({
  method: "get",
  path: "/passkeys",
  tags: ["User"],
  description: "Check if the current user has a registered passkey.",
  responses: {
    ...json200Response(PasskeyStatusSchema, "Passkey status"),
  },
});

userRouter.openapi(passkeyStatusRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const rows = await db
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, user.id))
    .limit(1);

  return c.json({ hasPasskey: rows.length > 0 }, 200);
});

// ----- UI preferences -----

export const UI_THEMES = ["default", "gmail", "outlook"] as const;
export const COLOR_MODES = ["light", "dark", "system"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;
export const PALETTES = [
  "navy",
  "ink",
  "slate",
  "indigo",
  "forest",
  "claret",
  "paper",
] as const;

const PreferencesSchema = z.object({
  uiTheme: z.enum(UI_THEMES),
  colorMode: z.enum(COLOR_MODES),
  density: z.enum(DENSITIES),
  palette: z.enum(PALETTES),
  /** Per-layout view settings, keyed by layout ("gmail", "outlook", …). */
  layoutSettings: z.record(z.string(), z.record(z.string(), z.unknown())),
  /** When each inbox tab was last viewed (unix seconds), for "N new". */
  tabSeen: z.record(z.string(), z.number()),
});

const LAYOUT_SETTINGS_MAX_BYTES = 16 * 1024;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

const DEFAULT_PREFERENCES: z.infer<typeof PreferencesSchema> = {
  uiTheme: "default",
  colorMode: "system",
  density: "comfortable",
  palette: "navy",
  layoutSettings: {},
  tabSeen: {},
};

function readPreferences(
  row: typeof userPreferences.$inferSelect | undefined,
): z.infer<typeof PreferencesSchema> {
  const pick = <T extends readonly string[]>(
    allowed: T,
    value: string | null | undefined,
    fallback: T[number],
  ): T[number] =>
    value && (allowed as readonly string[]).includes(value)
      ? (value as T[number])
      : fallback;
  return {
    uiTheme: pick(UI_THEMES, row?.uiTheme, DEFAULT_PREFERENCES.uiTheme),
    colorMode: pick(COLOR_MODES, row?.colorMode, DEFAULT_PREFERENCES.colorMode),
    density: pick(DENSITIES, row?.density, DEFAULT_PREFERENCES.density),
    palette: pick(PALETTES, row?.palette, DEFAULT_PREFERENCES.palette),
    layoutSettings: parseJson(row?.layoutSettings, {}),
    tabSeen: parseJson(row?.tabSeen, {}),
  };
}

const getPreferencesRoute = createRoute({
  method: "get",
  path: "/preferences",
  tags: ["User"],
  description:
    "The signed-in user's UI preferences (mail layout, colour mode, density, default-layout palette).",
  responses: {
    ...json200Response(PreferencesSchema, "Preferences, with defaults filled"),
  },
});

userRouter.openapi(getPreferencesRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const [row] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, user.id))
    .limit(1);
  return c.json(readPreferences(row), 200);
});

const updatePreferencesRoute = createRoute({
  method: "patch",
  path: "/preferences",
  tags: ["User"],
  description:
    "Update one or more UI preferences. Omitted fields keep their value. `layoutSettings` and `tabSeen` merge by top-level key (a layout's settings object is replaced whole).",
  request: {
    body: {
      content: {
        "application/json": { schema: PreferencesSchema.partial() },
      },
    },
  },
  responses: {
    ...json200Response(PreferencesSchema, "Preferences after the update"),
    400: {
      description: "Layout settings too large",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
});

userRouter.openapi(updatePreferencesRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const patch = c.req.valid("json");
  const [existing] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, user.id))
    .limit(1);
  const current = readPreferences(existing);
  const next = {
    ...current,
    ...patch,
    layoutSettings: {
      ...current.layoutSettings,
      ...(patch.layoutSettings ?? {}),
    },
    tabSeen: { ...current.tabSeen, ...(patch.tabSeen ?? {}) },
  };
  const layoutJson = JSON.stringify(next.layoutSettings);
  if (layoutJson.length > LAYOUT_SETTINGS_MAX_BYTES) {
    return c.json({ error: "Layout settings are too large" }, 400);
  }
  const row = {
    uiTheme: next.uiTheme,
    colorMode: next.colorMode,
    density: next.density,
    palette: next.palette,
    layoutSettings: layoutJson,
    tabSeen: JSON.stringify(next.tabSeen),
  };
  const now = Date.now();
  await db
    .insert(userPreferences)
    .values({ userId: user.id, ...row, updatedAt: now })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { ...row, updatedAt: now },
    });
  return c.json(next, 200);
});
