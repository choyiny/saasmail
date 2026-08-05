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

/**
 * Fetch an attachment only if the caller owns the inbox of the message it
 * belongs to.
 *
 * The owning inbox differs by kind, and getting this backwards silently grants
 * access: an inbound attachment belongs to `emails.recipient` (the inbox that
 * received it), while a sent one belongs to `sent_emails.from_address` (the
 * inbox it was sent from) — the external `to_address` is not an inbox anyone
 * holds permission on. This mirrors the pair of checks the email detail routes
 * already make.
 *
 * Returns null both when the attachment does not exist and when the caller may
 * not read it, so callers answer 404 either way. A 403 would confirm that an
 * attachment id exists, which is most of what an id-guessing attacker wants.
 */
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

  // An attachment whose message row is gone is unreachable rather than public.
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
      // `private`, not `public`: this is authenticated mailbox content, and
      // `public` licenses shared caches and proxies in front of the worker to
      // store it and hand it to a different caller. The body is immutable for
      // a given id, so the requesting browser's own cache can still keep it.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});
