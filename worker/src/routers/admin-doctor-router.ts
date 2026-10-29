import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { runDoctor } from "../lib/doctor";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const adminDoctorRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const DoctorReportSchema = z.object({
  build: z.object({
    version: z.string(),
    commit: z.string(),
    commitShort: z.string(),
    commitTime: z.string().nullable(),
    dirty: z.boolean(),
    dirtyFiles: z.array(z.string()),
    dirtyCount: z.number().int(),
    builtAt: z.string(),
  }),
  checkedAt: z.number().int(),
  checks: z.array(
    z.object({
      id: z.string(),
      group: z.string(),
      status: z.enum(["pass", "warn", "fail", "info"]),
      summary: z.string(),
      hint: z.string().optional(),
    }),
  ),
});

const getDoctorRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  security: bearerSecurity,
  description:
    "Run the deployment's runtime checks (migrations, secrets as booleans, bindings, provider, cron, outbox, backups, inbound) and return the build stamp. Admin only; never returns a secret value.",
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "Build stamp and check results",
      content: { "application/json": { schema: DoctorReportSchema } },
    },
  },
});

adminDoctorRouter.openapi(getDoctorRoute, async (c) => {
  return c.json(await runDoctor(c.env, { db: c.get("db") }), 200);
});
