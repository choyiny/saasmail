import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";
import type { RuleAction, RuleCondition } from "../lib/rules/types";

export const rules = sqliteTable(
  "rules",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    inbox: text("inbox"),
    trigger: text("trigger").notNull().default("message.received"),
    conditions: text("conditions", { mode: "json" })
      .$type<RuleCondition[]>()
      .notNull(),
    actions: text("actions", { mode: "json" }).$type<RuleAction[]>().notNull(),
    position: integer("position").notNull(),
    stopProcessing: integer("stop_processing").notNull().default(0),
    enabled: integer("enabled").notNull().default(1),
    matchCount: integer("match_count").notNull().default(0),
    lastMatchedAt: integer("last_matched_at"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("rules_enabled_position_idx").on(table.enabled, table.position),
  ],
);
