import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { users, passkeys } from "../db/auth.schema";
import { invitations } from "../db/invitations.schema";
import { appSettings } from "../db/app-settings.schema";
import { json200Response, json201Response } from "../lib/helpers";
import type { Variables } from "../variables";

/** Default brand name when no row is set in app_settings. */
const DEFAULT_BRAND_NAME = "saasmail";

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

const revokeInviteRoute = createRoute({
  method: "delete",
  path: "/invites/{id}",
  tags: ["Admin"],
  description: "Revoke an invitation by id.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(
      z.object({ success: z.literal(true) }),
      "Invite revoked",
    ),
    404: {
      description: "Invite not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRouter.openapi(revokeInviteRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const target = await db
    .select()
    .from(invitations)
    .where(eq(invitations.id, id))
    .get();
  if (!target) {
    return c.json({ error: "Invite not found" }, 404);
  }

  await db.delete(invitations).where(eq(invitations.id, id));
  return c.json({ success: true as const }, 200);
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

// --- App Settings Endpoints ---

const UpdateSettingsSchema = z.object({
  // null clears the row and reverts to the built-in default.
  brandName: z.string().nullable().optional(),
});

const SettingsResponseSchema = z.object({
  brandName: z.string(),
});

const updateSettingsRoute = createRoute({
  method: "patch",
  path: "/settings",
  tags: ["Admin"],
  description:
    "Update app-wide settings (currently: brand name). Pass `null` to reset to the default.",
  request: {
    body: {
      content: { "application/json": { schema: UpdateSettingsSchema } },
    },
  },
  responses: {
    ...json200Response(SettingsResponseSchema, "Settings updated"),
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRouter.openapi(updateSettingsRoute, async (c) => {
  const db = c.get("db");
  const currentUser = c.get("user");
  const body = c.req.valid("json");

  // Only act on brand_name if the field is present in the body. `undefined`
  // means "no change", `null` means "reset to default".
  if ("brandName" in body) {
    const rawValue = body.brandName;
    let storedValue: string | null;
    if (rawValue === null) {
      storedValue = null;
    } else if (rawValue === undefined) {
      // Defensive — `in` already narrowed this above, but keep the type check.
      storedValue = null;
    } else {
      const trimmed = rawValue.trim();
      if (trimmed.length < 1 || trimmed.length > 40) {
        return c.json({ error: "Brand name must be 1-40 characters." }, 400);
      }
      storedValue = trimmed;
    }

    const now = Math.floor(Date.now() / 1000);
    // INSERT OR REPLACE via drizzle's onConflictDoUpdate — works with the
    // primary-key uniqueness on `key`.
    await db
      .insert(appSettings)
      .values({
        key: "brand_name",
        value: storedValue,
        updatedAt: now,
        updatedBy: currentUser?.id ?? null,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value: storedValue,
          updatedAt: now,
          updatedBy: currentUser?.id ?? null,
        },
      });
  }

  // Always return the resolved value so the caller can update its UI.
  const row = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "brand_name"))
    .limit(1);
  const resolved =
    row.length > 0 && row[0].value && row[0].value.length > 0
      ? row[0].value
      : DEFAULT_BRAND_NAME;

  return c.json({ brandName: resolved }, 200);
});
