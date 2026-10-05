import { AUDIT_ACTIONS } from "./audit/events";
import { recordAudit } from "./audit/record";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { appSettings } from "../db/app-settings.schema";

const WEBHOOK_KEY = "webhook";

export interface WebhookConfig {
  url: string;
  secret: string | null;
}

/** Read the single global webhook config. null = unconfigured/disabled/malformed. */
export async function getWebhookConfig(
  db: DrizzleD1Database<any>,
): Promise<WebhookConfig | null> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, WEBHOOK_KEY))
    .limit(1);
  const raw = rows[0]?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { url?: unknown; secret?: unknown };
    const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
    if (!url) return null;
    const secret =
      typeof parsed.secret === "string" && parsed.secret.length > 0
        ? parsed.secret
        : null;
    return { url, secret };
  } catch {
    return null;
  }
}

/**
 * Where a URL points, for the audit log: scheme, host and path. A username,
 * a password, the query and the fragment can each hold a token.
 */
function loggableUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(unparseable URL)";
  }
}

/** Write the global webhook config. Pass null (or a blank url) to clear/disable. */
export async function setWebhookConfig(
  db: DrizzleD1Database<any>,
  cfg: WebhookConfig | null,
  updatedBy: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const url = cfg?.url.trim() ?? "";
  const value = url
    ? JSON.stringify({
        url,
        secret: cfg?.secret && cfg.secret.length > 0 ? cfg.secret : null,
      })
    : null;
  await db
    .insert(appSettings)
    .values({ key: WEBHOOK_KEY, value, updatedAt: now, updatedBy })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now, updatedBy },
    });
  // The signing secret is never written to the log: only whether one is set.
  await recordAudit(db, {
    action: AUDIT_ACTIONS.settingsChanged,
    targetType: "setting",
    targetId: WEBHOOK_KEY,
    summary: url
      ? `Set the inbound webhook to ${loggableUrl(url)}`
      : "Turned the inbound webhook off",
    details: {
      key: WEBHOOK_KEY,
      url: url ? loggableUrl(url) : null,
      hasSecret: Boolean(cfg?.secret && cfg.secret.length > 0),
    },
  });
}
