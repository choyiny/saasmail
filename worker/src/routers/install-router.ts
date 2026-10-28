import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "../db/schema";

/** Public: what `yarn saasmail install` reads to recognise an existing installation. Never the nonce. */
export const installRouter = new Hono<{ Bindings: CloudflareBindings }>();

function installationIdOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const id = (JSON.parse(raw) as { installationId?: unknown }).installationId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function schemaDigestOf(manifestJson: string | null | undefined) {
  if (!manifestJson) return null;
  try {
    const d = (JSON.parse(manifestJson) as { schemaDigest?: unknown })
      .schemaDigest;
    return typeof d === "string" ? d : null;
  } catch {
    return null;
  }
}

installRouter.get("/.well-known/saasmail", async (c) => {
  const installationId = installationIdOf(c.env.SAASMAIL_INSTALLATION);
  let schemaDigest: string | null = null;
  if (installationId) {
    const row = await drizzle(c.env.DB, { schema })
      .select({ manifestJson: schema.installState.manifestJson })
      .from(schema.installState)
      .where(eq(schema.installState.installationId, installationId))
      .get();
    schemaDigest = schemaDigestOf(row?.manifestJson);
  }
  return c.json({
    installationId,
    version: c.env.SAASMAIL_VERSION || null,
    schemaDigest,
  });
});
