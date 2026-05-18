import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { users } from "../db/auth.schema";
import { createAuth } from "../auth";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const setupRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const StatusSchema = z.object({
  setupRequired: z.boolean(),
});

const MigrationRequiredSchema = z.object({
  error: z.string(),
  code: z.literal("DATABASE_MIGRATION_REQUIRED"),
  command: z.literal("yarn db:migrate:prod"),
});

const MIGRATION_REQUIRED_RESPONSE = {
  error:
    "Database migrations have not been applied yet. Run `yarn db:migrate:prod` to create the production D1 tables, or run `/saasmail-onboarding` to walk through setup, then reload saasmail.",
  code: "DATABASE_MIGRATION_REQUIRED",
  command: "yarn db:migrate:prod",
} as const;

function isMissingUsersTableError(err: unknown): boolean {
  let current: unknown = err;
  while (current instanceof Error) {
    if (current.message.includes("no such table: users")) return true;
    current = current.cause;
  }
  return String(current).includes("no such table: users");
}

const SetupRequestSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const SetupResponseSchema = z.object({
  success: z.boolean(),
});

const ErrorSchema = z.object({
  error: z.string(),
});

async function countUsers(db: Variables["db"]): Promise<number> {
  const result = await db.select({ count: sql<number>`COUNT(*)` }).from(users);
  return result[0]?.count ?? 0;
}

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["Setup"],
  description: "Check whether initial setup is required (no users exist).",
  responses: {
    ...json200Response(StatusSchema, "Setup status"),
    503: {
      description: "Database migrations have not been applied",
      content: { "application/json": { schema: MigrationRequiredSchema } },
    },
  },
});

setupRouter.openapi(statusRoute, async (c) => {
  const db = c.get("db");
  try {
    const count = await countUsers(db);
    return c.json({ setupRequired: count === 0 }, 200);
  } catch (err) {
    if (isMissingUsersTableError(err)) {
      return c.json(MIGRATION_REQUIRED_RESPONSE, 503);
    }
    throw err;
  }
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["Setup"],
  description:
    "Create the first administrator user. Only available when no users exist.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: SetupRequestSchema,
        },
      },
    },
  },
  responses: {
    ...json200Response(SetupResponseSchema, "First user created"),
    403: {
      description: "Setup has already been completed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description: "Database migrations have not been applied",
      content: { "application/json": { schema: MigrationRequiredSchema } },
    },
  },
});

setupRouter.openapi(createRouteDef, async (c) => {
  const db = c.get("db");

  // Guard: reject if any users already exist.
  let count: number;
  try {
    count = await countUsers(db);
  } catch (err) {
    if (isMissingUsersTableError(err)) {
      return c.json(MIGRATION_REQUIRED_RESPONSE, 503);
    }
    throw err;
  }
  if (count > 0) {
    return c.json({ error: "Setup has already been completed" }, 403);
  }

  const { name, email, password } = c.req.valid("json");

  const auth = createAuth(c.env);

  try {
    await auth.api.createUser({
      body: { name, email, password, role: "admin" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signup failed";
    return c.json({ error: message }, 400);
  }

  return c.json({ success: true }, 200);
});
