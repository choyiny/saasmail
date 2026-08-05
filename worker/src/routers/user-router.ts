import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { passkeys } from "../db/auth.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const userRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const PasskeyStatusSchema = z.object({
  hasPasskey: z.boolean(),
});

const passkeyStatusRoute = createRoute({
  method: "get",
  path: "/passkeys",
  tags: ["User"],
  description: "Check if the current user has a registered passkey.",
  responses: {
    ...json200Response(PasskeyStatusSchema, "Passkey status"),
  },
});

userRouter.openapi(passkeyStatusRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const rows = await db
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, user.id))
    .limit(1);

  return c.json({ hasPasskey: rows.length > 0 }, 200);
});

const MeSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.string().nullable().openapi({
    description:
      'Either "admin" or "member". Advisory only — every admin route is enforced server-side regardless of what a client does with this.',
  }),
});

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["User"],
  description:
    "The authenticated caller's identity and role. A client needs the role to decide whether to offer admin screens at all; without it the only way to find out is to call an admin route and read the 403.",
  responses: {
    ...json200Response(MeSchema, "Current user"),
  },
});

userRouter.openapi(meRoute, async (c) => {
  const user = c.get("user");
  return c.json(
    {
      id: user.id,
      email: user.email,
      name: user.name ?? null,
      role: user.role ?? null,
    },
    200,
  );
});
