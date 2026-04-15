import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { apiKeys } from "../db/api-keys.schema";
import {
  generateApiKey,
  hashApiKey,
} from "../lib/api-keys";
import { json200Response, json201Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const apiKeysRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
});

const CreateApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(100),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

const CreateApiKeyResponseSchema = ApiKeySchema.extend({
  // Full key is only returned once at creation time.
  key: z.string(),
});

const ErrorSchema = z.object({ error: z.string() });

function serializeApiKey(row: typeof apiKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    createdAt: row.createdAt.getTime(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
    revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
  };
}

// List API keys
const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["API Keys"],
  description: "List API keys for the current user.",
  responses: {
    ...json200Response(z.array(ApiKeySchema), "List of API keys"),
  },
});

apiKeysRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.id))
    .orderBy(desc(apiKeys.createdAt));
  return c.json(rows.map(serializeApiKey), 200);
});

// Create API key
const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["API Keys"],
  description:
    "Create a new API key. The raw key is returned only once in this response.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateApiKeyRequestSchema,
        },
      },
    },
  },
  responses: {
    ...json201Response(CreateApiKeyResponseSchema, "API key created"),
    401: {
      description: "API keys cannot be used to mint new API keys",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

apiKeysRouter.openapi(createRouteDef, async (c) => {
  // Prevent API-key callers from minting new keys (session-only).
  if (c.get("authMethod") === "api_key") {
    return c.json(
      { error: "API keys cannot be created via an API key" },
      401
    );
  }

  const db = c.get("db");
  const user = c.get("user");
  const { name, expiresInDays } = c.req.valid("json");

  const { fullKey, prefix } = generateApiKey();
  const keyHash = await hashApiKey(fullKey);
  const now = new Date();
  const expiresAt = expiresInDays
    ? new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const row = {
    id: nanoid(),
    userId: user.id,
    name,
    keyHash,
    keyPrefix: prefix,
    lastUsedAt: null,
    expiresAt,
    revokedAt: null,
    createdAt: now,
  };

  await db.insert(apiKeys).values(row);

  return c.json(
    {
      ...serializeApiKey(row),
      key: fullKey,
    },
    201
  );
});

// Revoke API key
const revokeRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["API Keys"],
  description: "Revoke an API key.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "API key revoked"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

apiKeysRouter.openapi(revokeRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { id } = c.req.valid("param");

  const existing = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
    .limit(1);

  if (existing.length === 0) {
    return c.json({ error: "API key not found" }, 404);
  }

  if (existing[0].revokedAt) {
    return c.json({ success: true }, 200);
  }

  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)));

  return c.json({ success: true }, 200);
});
