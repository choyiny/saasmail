import { OpenAPIHono } from "@hono/zod-openapi";
import type { Variables } from "../variables";

export const sendRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();
