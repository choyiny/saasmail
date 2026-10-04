import { AUDIT_ACTIONS } from "../lib/audit/events";
import { recordAudit } from "../lib/audit/record";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { users, passkeys } from "../db/auth.schema";
import { invitations } from "../db/invitations.schema";
import { appSettings } from "../db/app-settings.schema";
import { resolveBrandName } from "../lib/brand-name";
import { json200Response, json201Response } from "../lib/helpers";
import type { Variables } from "../variables";
import type { OutboxDrainMessage } from "../lib/outbox";
import {
  recentUnknownRecipients,
  rejectsUnknownRecipients,
  setRejectUnknownRecipients,
} from "../lib/inbound-rejection";
import {
  SEND_CHANNELS,
  readDailySendLimits,
  readSendUsage,
  readSendingPause,
  setDailySendLimits,
  setSendingPaused,
  utcDay,
  type DailySendLimits,
} from "../lib/sending-controls";

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
  await recordAudit(db, {
    action: AUDIT_ACTIONS.userInvited,
    targetType: "user",
    summary: invite.email
      ? `Invited ${invite.email} as ${role}`
      : `Created an open invitation for a ${role}`,
    details: {
      inviteId: invite.id,
      role,
      email: invite.email,
      expiresAt: Math.floor(invite.expiresAt.getTime() / 1000),
    },
  });

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
  if (target.role !== role) {
    await recordAudit(db, {
      action: AUDIT_ACTIONS.userRoleChanged,
      targetType: "user",
      targetId: id,
      summary: `Changed ${target.email} from ${target.role ?? "member"} to ${role}`,
      details: { email: target.email, from: target.role ?? null, to: role },
    });
  }
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
  await recordAudit(db, {
    action: AUDIT_ACTIONS.userRemoved,
    targetType: "user",
    targetId: id,
    summary: `Removed ${target.email} (${target.role ?? "member"})`,
    details: { email: target.email, role: target.role ?? null },
  });
  return c.json({ success: true as const }, 200);
});

// --- App Settings Endpoints ---

const UpdateSettingsSchema = z.object({
  // null clears the row and reverts to the built-in default.
  brandName: z.string().nullable().optional(),
  outboundPaused: z.boolean().optional().openapi({
    description:
      "Pause (`true`) or resume (`false`) outbound sending. While paused every send is recorded and held in the outbox; resuming delivers what was held at once.",
  }),
  rejectUnknownRecipients: z.boolean().optional().openapi({
    description:
      "Refuse inbound mail to addresses that are not inboxes (no sender identity and no assigned members) at SMTP time, with a permanent error and `No such mailbox`. Off by default: the catch-all stores mail to any address under the routed domains.",
  }),
  dailySendLimits: z
    .object({
      web: z.number().int().min(0).max(1_000_000).nullable(),
      api: z.number().int().min(0).max(1_000_000).nullable(),
      mcp: z.number().int().min(0).max(1_000_000).nullable(),
      jmap: z.number().int().min(0).max(1_000_000).nullable(),
    })
    .partial()
    .optional()
    .openapi({
      description:
        "Messages each user may send a UTC day through a channel. `null` is unlimited, `0` blocks the channel; channels left out keep their limit.",
    }),
});

const DailySendLimitsSchema = z.object({
  web: z.number().int().nullable(),
  api: z.number().int().nullable(),
  mcp: z.number().int().nullable(),
  jmap: z.number().int().nullable(),
});

const SettingsResponseSchema = z.object({
  brandName: z.string(),
  outboundPaused: z.boolean(),
  outboundPause: z
    .object({
      since: z.number().int(),
      byLabel: z.string(),
    })
    .nullable(),
  dailySendLimits: DailySendLimitsSchema,
  rejectUnknownRecipients: z.boolean(),
});

const updateSettingsRoute = createRoute({
  method: "patch",
  path: "/settings",
  tags: ["Admin"],
  description:
    "Update app-wide settings: the brand name (`null` resets it to the default), the outbound pause and the daily send limits. Fields left out are unchanged.",
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
    403: {
      description:
        "Resuming outbound sending or changing a daily send limit with an API key (`SESSION_REQUIRED`): sign in instead. An API key may pause.",
      content: {
        "application/json": {
          schema: z.object({ error: z.string(), code: z.string() }),
        },
      },
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readSettings(
  db: any,
): Promise<z.infer<typeof SettingsResponseSchema>> {
  const [brand] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "brand_name"))
    .limit(1);
  const pause = await readSendingPause(db);
  return {
    brandName: resolveBrandName(brand?.value),
    outboundPaused: pause !== null,
    outboundPause: pause
      ? { since: pause.since, byLabel: pause.byLabel }
      : null,
    dailySendLimits: await readDailySendLimits(db),
    rejectUnknownRecipients: await rejectsUnknownRecipients(db),
  };
}

const getSettingsRoute = createRoute({
  method: "get",
  path: "/settings",
  tags: ["Admin"],
  description:
    "App-wide settings: brand name, whether outbound sending is paused (and since when, by whom) and the daily send limits per channel.",
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Settings",
      content: { "application/json": { schema: SettingsResponseSchema } },
    },
  },
});

adminRouter.openapi(getSettingsRoute, async (c) => {
  return c.json(await readSettings(c.get("db")), 200);
});

const unknownRecipientsRoute = createRoute({
  method: "get",
  path: "/settings/unknown-recipients",
  tags: ["Admin"],
  description:
    "Addresses that received mail in the last 30 days but are not inboxes (no sender identity, no assigned members): what `rejectUnknownRecipients` would start to refuse. Busiest first, at most 50.",
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Addresses that would be refused",
      content: {
        "application/json": {
          schema: z.object({
            addresses: z.array(
              z.object({
                address: z.string(),
                count: z.number().int(),
                lastReceivedAt: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
  },
});

adminRouter.openapi(unknownRecipientsRoute, async (c) => {
  return c.json(
    {
      addresses: await recentUnknownRecipients(c.get("db"), {
        now: Math.floor(Date.now() / 1000),
      }),
    },
    200,
  );
});

const SendUsageSchema = z.object({
  day: z.string(),
  limits: DailySendLimitsSchema,
  usage: z.array(
    z.object({
      channel: z.string(),
      userId: z.string(),
      email: z.string().nullable(),
      count: z.number().int(),
    }),
  ),
});

const sendUsageRoute = createRoute({
  method: "get",
  path: "/send-usage",
  tags: ["Admin"],
  description:
    "Messages counted against the daily send limits on a UTC day (default today), per channel and user, busiest first, at most 20. Only limited channels are counted.",
  request: {
    query: z.object({
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .openapi({
          description: "UTC day, `YYYY-MM-DD`.",
          example: "2026-10-04",
        }),
    }),
  },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Send usage",
      content: { "application/json": { schema: SendUsageSchema } },
    },
  },
});

adminRouter.openapi(sendUsageRoute, async (c) => {
  const db = c.get("db");
  const day = c.req.valid("query").day ?? utcDay(Math.floor(Date.now() / 1000));
  return c.json(
    {
      day,
      limits: await readDailySendLimits(db),
      usage: await readSendUsage(db, day),
    },
    200,
  );
});

adminRouter.openapi(updateSettingsRoute, async (c) => {
  const db = c.get("db");
  const currentUser = c.get("user");
  const body = c.req.valid("json");

  // The incident controls must not be undone with a leaked key: an API key
  // may pause, but resuming and changing a limit take a signed-in admin
  // (whose session passed the passkey gate). Checked before any change.
  if (
    c.get("authMethod") === "apiKey" &&
    (body.outboundPaused === false || body.dailySendLimits !== undefined)
  ) {
    return c.json(
      {
        error:
          "Resuming outbound sending or changing a daily send limit needs a signed-in admin, not an API key.",
        code: "SESSION_REQUIRED",
      },
      403,
    );
  }

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
    const [before] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, "brand_name"))
      .limit(1);
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
    const previous = before?.value ?? null;
    if (previous !== storedValue) {
      await recordAudit(db, {
        action: AUDIT_ACTIONS.settingsChanged,
        targetType: "setting",
        targetId: "brand_name",
        summary:
          storedValue === null
            ? "Reset the brand name to the default"
            : `Changed the brand name to '${storedValue}'`,
        details: { key: "brand_name", from: previous, to: storedValue },
      });
    }
  }

  if (body.dailySendLimits) {
    const changes: Partial<DailySendLimits> = {};
    for (const channel of SEND_CHANNELS) {
      if (channel in body.dailySendLimits) {
        changes[channel] = body.dailySendLimits[channel] ?? null;
      }
    }
    await setDailySendLimits(db, changes);
  }

  if (body.rejectUnknownRecipients !== undefined) {
    await setRejectUnknownRecipients(db, body.rejectUnknownRecipients);
  }

  if (body.outboundPaused !== undefined) {
    const { changed } = await setSendingPaused(db, body.outboundPaused);
    if (changed && !body.outboundPaused) {
      // Held mail goes out through the queue, a batch per message, starting
      // now rather than at the next hourly run (which is the fallback).
      try {
        const drain: OutboxDrainMessage = { type: "outbox_drain" };
        await c.env.EMAIL_QUEUE.send(drain);
      } catch (err) {
        console.error("[sending] could not start delivering held mail:", err);
      }
    }
  }

  // Always return the resolved values so the caller can update its UI.
  return c.json(await readSettings(db), 200);
});
