import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const agentDefinitions = sqliteTable("agent_definitions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  // Workers AI model ID, e.g. "@cf/meta/llama-3.3-70b-instruct"
  modelId: text("model_id").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  // Full JSON Schema object (serialised). Shape:
  //   { type: "object", properties: { key: { type: "string", description: "…" } }, required: […] }
  // Template vars must be a subset of properties keys — enforced at assignment time.
  outputSchemaJson: text("output_schema_json").notNull(),
  maxRunsPerHour: integer("max_runs_per_hour").notNull().default(10),
  isActive: integer("is_active").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
