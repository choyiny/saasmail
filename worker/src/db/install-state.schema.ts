import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Written by `yarn saasmail install`: one row per installation of this
 * instance. `ownership_nonce` proves the installer owns the deployment and is
 * never served by `/.well-known/saasmail`.
 */
export const installState = sqliteTable("install_state", {
  installationId: text("installation_id").primaryKey(),
  ownershipNonce: text("ownership_nonce").notNull(),
  version: text("version"),
  manifestJson: text("manifest_json"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
