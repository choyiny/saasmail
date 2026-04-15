import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { users } from "../db/auth.schema";
import { invitations } from "../db/invitations.schema";
import { createAuth } from "../auth";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const invitesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const InviteInfoSchema = z.object({
  valid: z.boolean(),
  role: z.string().optional(),
  email: z.string().nullable().optional(),
});

const AcceptInviteSchema = z.object({
  token: z.string(),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const validateInviteRoute = createRoute({
  method: "get",
  path: "/{token}",
  tags: ["Invites"],
  description: "Check if an invitation token is valid.",
  request: {
    params: z.object({ token: z.string() }),
  },
  responses: {
    ...json200Response(InviteInfoSchema, "Invite status"),
  },
});

invitesRouter.openapi(validateInviteRoute, async (c) => {
  const db = c.get("db");
  const { token } = c.req.valid("param");

  const invite = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .get();

  if (!invite) {
    return c.json({ valid: false }, 200);
  }

  const expiresAt =
    invite.expiresAt instanceof Date
      ? invite.expiresAt
      : new Date((invite.expiresAt as unknown as number) * 1000);
  if (invite.usedBy || expiresAt < new Date()) {
    return c.json({ valid: false }, 200);
  }

  return c.json({ valid: true, role: invite.role, email: invite.email }, 200);
});

const acceptInviteRoute = createRoute({
  method: "post",
  path: "/accept",
  tags: ["Invites"],
  description: "Accept an invitation and create a user account.",
  request: {
    body: {
      content: { "application/json": { schema: AcceptInviteSchema } },
    },
  },
  responses: {
    ...json200Response(
      z.object({ success: z.boolean(), userId: z.string() }),
      "Account created",
    ),
    400: {
      description: "Invalid or expired invite",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

invitesRouter.openapi(acceptInviteRoute, async (c) => {
  const db = c.get("db");
  const { token, name, email, password } = c.req.valid("json");

  const invite = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .get();

  if (!invite) {
    return c.json({ error: "Invalid invitation token" }, 400);
  }

  const expiresAt =
    invite.expiresAt instanceof Date
      ? invite.expiresAt
      : new Date((invite.expiresAt as unknown as number) * 1000);
  if (expiresAt < new Date()) {
    return c.json({ error: "Invitation has expired" }, 400);
  }

  if (invite.usedBy) {
    return c.json({ error: "Invitation has already been used" }, 400);
  }

  if (invite.email && invite.email !== email) {
    return c.json({ error: "Email does not match the invitation" }, 400);
  }

  const auth = createAuth(c.env);

  let newUser;
  try {
    newUser = await auth.api.createUser({
      body: { email, password, name, role: invite.role },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Account creation failed";
    return c.json({ error: message }, 400);
  }

  await db
    .update(invitations)
    .set({ usedBy: newUser.user.id, usedAt: new Date() })
    .where(eq(invitations.token, token));

  return c.json({ success: true, userId: newUser.user.id }, 200);
});
