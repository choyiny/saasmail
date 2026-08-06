import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { attachments } from "../db/attachments.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { isInboxAllowed } from "../lib/inbox-permissions";
import type { Variables } from "../variables";

export const attachmentsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// The owning inbox is `emails.recipient` for inbound and
// `sent_emails.from_address` for sent — the external `to_address` is nobody's
// inbox. Null covers both "missing" and "not allowed" so both answer 404; a 403
// would confirm the id exists.
async function findReadableAttachment(
  db: Variables["db"],
  allowed: NonNullable<Variables["allowedInboxes"]>,
  id: string,
) {
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  const att = rows[0];

  const owner =
    att.kind === "sent"
      ? await db
          .select({ inbox: sentEmails.fromAddress })
          .from(sentEmails)
          .where(eq(sentEmails.id, att.emailId))
          .limit(1)
      : await db
          .select({ inbox: emails.recipient })
          .from(emails)
          .where(eq(emails.id, att.emailId))
          .limit(1);

  // Orphaned attachment (message row gone) fails closed.
  if (owner.length === 0) return null;
  if (!isInboxAllowed(allowed, owner[0].inbox)) return null;

  return att;
}

const downloadRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Attachments"],
  description:
    "Download an attachment from R2. Scoped to the caller's allowed inboxes.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Attachment file" },
    404: { description: "Attachment not found, or not in an allowed inbox" },
  },
});

attachmentsRouter.openapi(downloadRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");

  const att = await findReadableAttachment(db, allowed, id);
  if (!att) {
    return c.json({ error: "Attachment not found" }, 404);
  }

  const object = await c.env.R2.get(att.r2Key);
  if (!object) {
    return c.json({ error: "File not found in storage" }, 404);
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": att.contentType,
      "Content-Disposition": `attachment; filename="${att.filename}"`,
      "Content-Length": att.size.toString(),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});

// Serve attachment inline (for CID images in email HTML)
const inlineRoute = createRoute({
  method: "get",
  path: "/{id}/inline",
  tags: ["Attachments"],
  description:
    "Serve an attachment inline (for embedded images). Scoped to the caller's allowed inboxes.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Inline attachment" },
    404: { description: "Attachment not found, or not in an allowed inbox" },
  },
});

attachmentsRouter.openapi(inlineRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { id } = c.req.valid("param");

  const att = await findReadableAttachment(db, allowed, id);
  if (!att) {
    return c.json({ error: "Attachment not found" }, 404);
  }

  const object = await c.env.R2.get(att.r2Key);
  if (!object) {
    return c.json({ error: "File not found in storage" }, 404);
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": att.contentType,
      "Content-Disposition": "inline",
      "Content-Length": att.size.toString(),
      // `public` would let shared caches serve this mailbox content to another
      // caller.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});
