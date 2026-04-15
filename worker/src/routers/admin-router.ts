import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { users, passkeys } from "../db/auth.schema";
import { invitations } from "../db/invitations.schema";
import { json200Response, json201Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const adminRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// --- Schemas ---

const InviteSchema = z.object({
  id: z.string(),
  token: z.string(),
  role: z.string(),
  email: z.string().nullable(),
  expiresAt: z.number(),
  usedBy: z.string().nullable(),
  usedAt: z.number().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
});

const CreateInviteSchema = z.object({
  role: z.enum(["admin", "member"]).default("member"),
  email: z.string().email().optional(),
  expiresInDays: z.number().min(1).max(30).default(7),
});

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string().nullable(),
  createdAt: z.number(),
  hasPasskey: z.boolean(),
});

const UpdateRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

const ErrorSchema = z.object({
  error: z.string(),
});

// --- Invite Endpoints ---

const createInviteRoute = createRoute({
  method: "post",
  path: "/invites",
  tags: ["Admin"],
  description: "Create an invitation link for a new user.",
  request: {
    body: {
      content: { "application/json": { schema: CreateInviteSchema } },
    },
  },
  responses: {
    ...json201Response(InviteSchema, "Invite created"),
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRouter.openapi(createInviteRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { role, email, expiresInDays } = c.req.valid("json");

  const now = new Date();
  const invite = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    role,
    email: email ?? null,
    expiresAt: new Date(now.getTime() + expiresInDays * 86400000),
    usedBy: null,
    usedAt: null,
    createdBy: user.id,
    createdAt: now,
  };

  await db.insert(invitations).values(invite);

  return c.json(
    {
      ...invite,
      expiresAt: Math.floor(invite.expiresAt.getTime() / 1000),
      createdAt: Math.floor(invite.createdAt.getTime() / 1000),
      usedAt: null,
    },
    201,
  );
});

const listInvitesRoute = createRoute({
  method: "get",
  path: "/invites",
  tags: ["Admin"],
  description: "List all invitations.",
  responses: {
    ...json200Response(z.array(InviteSchema), "List of invitations"),
  },
});

adminRouter.openapi(listInvitesRoute, async (c) => {
  const db = c.get("db");
  const rows = await db
    .select()
    .from(invitations)
    .orderBy(invitations.createdAt);

  const result = rows.map((row) => ({
    ...row,
    expiresAt:
      row.expiresAt instanceof Date
        ? Math.floor(row.expiresAt.getTime() / 1000)
        : row.expiresAt,
    createdAt:
      row.createdAt instanceof Date
        ? Math.floor(row.createdAt.getTime() / 1000)
        : row.createdAt,
    usedAt:
      row.usedAt instanceof Date
        ? Math.floor(row.usedAt.getTime() / 1000)
        : row.usedAt,
  }));

  return c.json(result, 200);
});

// --- User Management Endpoints ---

const listUsersRoute = createRoute({
  method: "get",
  path: "/users",
  tags: ["Admin"],
  description: "List all users with passkey status.",
  responses: {
    ...json200Response(z.array(UserSchema), "List of users"),
  },
});

adminRouter.openapi(listUsersRoute, async (c) => {
  const db = c.get("db");

  const allUsers = await db.select().from(users);

  const passkeyCountRows = await db
    .select({
      userId: passkeys.userId,
      count: sql<number>`COUNT(*)`,
    })
    .from(passkeys)
    .groupBy(passkeys.userId);

  const passkeyMap = new Map(passkeyCountRows.map((r) => [r.userId, r.count]));

  const result = allUsers.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    createdAt:
      u.createdAt instanceof Date
        ? Math.floor(u.createdAt.getTime() / 1000)
        : u.createdAt,
    hasPasskey: (passkeyMap.get(u.id) ?? 0) > 0,
  }));

  return c.json(result, 200);
});

const updateRoleRoute = createRoute({
  method: "patch",
  path: "/users/{id}/role",
  tags: ["Admin"],
  description: "Update a user's role.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: UpdateRoleSchema } },
    },
  },
  responses: {
    ...json200Response(z.object({ success: z.literal(true) }), "Role updated"),
    400: {
      description: "Cannot change own role",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRouter.openapi(updateRoleRoute, async (c) => {
  const db = c.get("db");
  const currentUser = c.get("user");
  const { id } = c.req.valid("param");
  const { role } = c.req.valid("json");

  if (id === currentUser.id) {
    return c.json({ error: "Cannot change your own role" }, 400);
  }

  const target = await db.select().from(users).where(eq(users.id, id)).get();
  if (!target) {
    return c.json({ error: "User not found" }, 404);
  }

  await db.update(users).set({ role }).where(eq(users.id, id));
  return c.json({ success: true as const }, 200);
});

const deleteUserRoute = createRoute({
  method: "delete",
  path: "/users/{id}",
  tags: ["Admin"],
  description: "Delete a user.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(z.object({ success: z.literal(true) }), "User deleted"),
    400: {
      description: "Cannot delete yourself",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRouter.openapi(deleteUserRoute, async (c) => {
  const db = c.get("db");
  const currentUser = c.get("user");
  const { id } = c.req.valid("param");

  if (id === currentUser.id) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }

  const target = await db.select().from(users).where(eq(users.id, id)).get();
  if (!target) {
    return c.json({ error: "User not found" }, 404);
  }

  await db.delete(users).where(eq(users.id, id));
  return c.json({ success: true as const }, 200);
});
