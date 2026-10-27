import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * Per-user UI preferences, one row per user.
 *
 *   - `uiTheme`:   "default" | "gmail" | "outlook" — which mail client the
 *                  inbox emulates. Null means "use the default".
 *   - `colorMode`: "light" | "dark" | "system".
 *   - `density`:   "comfortable" | "compact".
 *   - `palette`:   colour theme of the default layout (see PALETTES in
 *                  user-router.ts).
 *
 * Kept as plain text columns rather than enums so a new value is a frontend
 * change; the router validates the allowed set.
 */
export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  uiTheme: text("ui_theme"),
  colorMode: text("color_mode"),
  density: text("density"),
  /** Default layout colour theme: navy, ink, slate, indigo, forest, claret, paper. */
  palette: text("palette"),
  /**
   * JSON object of per-layout view settings (reading pane, swipe actions,
   * favorites, tabs on/off, undo-send delay …), keyed by layout. Opaque to
   * the server apart from a size cap.
   */
  layoutSettings: text("layout_settings"),
  /** JSON {category: unix seconds} — when each inbox tab was last viewed. */
  tabSeen: text("tab_seen"),
  updatedAt: integer("updated_at").notNull(),
});
