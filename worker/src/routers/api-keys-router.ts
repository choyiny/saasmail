import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { apiKeys } from "../db/api-keys.schema";
import { json200Response, json201Response } from "../lib/helpers";
import { hashKey } from "../lib/crypto";
import type { Variables } from "../variables";

export const apiKeysRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sk_${hex}`;
}

// GET /api/api-keys — get current key info
const getKeyRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["API Keys"],
  description:
    "Get the current user's API key info (prefix and creation date), or null if none exists.",
  responses: {
    ...json200Response(
      z.object({
        key: z
          .object({
            prefix: z.string(),
            createdAt: z.number(),
          })
          .nullable(),
      }),
      "API key info",
    ),
  },
});

apiKeysRouter.openapi(getKeyRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const rows = await db
    .select({ prefix: apiKeys.keyPrefix, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.id))
    .limit(1);
  return c.json({ key: rows[0] ?? null }, 200);
});

// POST /api/api-keys — generate (or regenerate) a key
const createKeyRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["API Keys"],
  description: "Generate a new API key. If one already exists, it is replaced.",
  responses: {
    ...json201Response(
      z.object({
        key: z.string(),
        prefix: z.string(),
        createdAt: z.number(),
      }),
      "Generated API key (shown only once)",
    ),
  },
});

apiKeysRouter.openapi(createKeyRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  // Delete existing key if any
  await db.delete(apiKeys).where(eq(apiKeys.userId, user.id));

  const rawKey = generateApiKey();
  const keyHash = await hashKey(rawKey);
  const prefix = rawKey.slice(0, 8) + "...";
  const now = Math.floor(Date.now() / 1000);

  await db.insert(apiKeys).values({
    id: nanoid(),
    userId: user.id,
    keyHash,
    keyPrefix: prefix,
    createdAt: now,
  });

  return c.json({ key: rawKey, prefix, createdAt: now }, 201);
});

// DELETE /api/api-keys — revoke the key
const deleteKeyRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["API Keys"],
  description: "Revoke the current user's API key.",
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Key revoked"),
  },
});

apiKeysRouter.openapi(deleteKeyRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  await db.delete(apiKeys).where(eq(apiKeys.userId, user.id));
  return c.json({ success: true }, 200);
});
