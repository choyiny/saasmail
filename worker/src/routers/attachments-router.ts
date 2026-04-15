import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { attachments } from "../db/attachments.schema";
import type { Variables } from "../variables";

export const attachmentsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const downloadRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Attachments"],
  description: "Download an attachment from R2.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Redirect to presigned URL or stream the file" },
  },
});

attachmentsRouter.openapi(downloadRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const att = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);

  if (att.length === 0) {
    return c.json({ error: "Attachment not found" }, 404);
  }

  const object = await c.env.R2.get(att[0].r2Key);
  if (!object) {
    return c.json({ error: "File not found in storage" }, 404);
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": att[0].contentType,
      "Content-Disposition": `attachment; filename="${att[0].filename}"`,
      "Content-Length": att[0].size.toString(),
    },
  });
});
