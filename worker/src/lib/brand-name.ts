import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { appSettings } from "../db/app-settings.schema";

/**
 * The instance display name, from the `brand_name` app setting.
 *
 * Three call sites need it (the public config route, the admin settings route,
 * and the MCP server's advertised identity) and each previously carried its own
 * copy of the fallback rule. Kept here so "unset, NULL, and empty string all
 * mean the default" is stated once.
 */
export const DEFAULT_BRAND_NAME = "saasmail";

/** Apply the fallback to a raw `brand_name` cell. */
export function resolveBrandName(value: string | null | undefined): string {
  return value && value.length > 0 ? value : DEFAULT_BRAND_NAME;
}

/** Read the instance display name. Never throws on a missing row. */
export async function readBrandName(
  db: DrizzleD1Database<any>,
): Promise<string> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "brand_name"))
    .limit(1);
  return resolveBrandName(rows[0]?.value);
}
