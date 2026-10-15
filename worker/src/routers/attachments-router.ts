import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, ne } from "drizzle-orm";
import { attachments } from "../db/attachments.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { isInboxAllowed } from "../lib/inbox-permissions";
import { sanitizeFilename } from "../lib/sanitize-filename";
import { isInlineImageType } from "../lib/inline-image-types";
import type { Variables } from "../variables";

export const attachmentsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// The owning inbox is `emails.recipient` for inbound and
// `sent_emails.from_address` for sent — the external `to_address` is nobody's
// inbox. A single query left-joins the owner from whichever table `kind`
// selects; the join predicate carries the `kind` test so only one side ever
// matches. Null covers both "message row gone" (orphaned, fails closed) and
// "not allowed" so both answer 404; a 403 would confirm the id exists.
async function findReadableAttachment(
  db: Variables["db"],
  allowed: NonNullable<Variables["allowedInboxes"]>,
  id: string,
) {
  const rows = await db
    .select({
      attachment: attachments,
      sentInbox: sentEmails.fromAddress,
      inboundInbox: emails.recipient,
    })
    .from(attachments)
    .leftJoin(
      emails,
      and(ne(attachments.kind, "sent"), eq(emails.id, attachments.emailId)),
    )
    .leftJoin(
      sentEmails,
      and(eq(attachments.kind, "sent"), eq(sentEmails.id, attachments.emailId)),
    )
    .where(eq(attachments.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  const { attachment, sentInbox, inboundInbox } = rows[0];

  const owner = attachment.kind === "sent" ? sentInbox : inboundInbox;
  // Null owner = orphaned message row (or unset address). Fail closed.
  if (owner === null || !isInboxAllowed(allowed, owner)) return null;

  return attachment;
}

/**
 * Headers on every attachment response, whichever route serves it.
 *
 * The bytes and their Content-Type come from a stranger. `nosniff` stops a
 * browser second-guessing the declared type into something executable, and
 * the sandbox CSP means that even a document opened straight from this origin
 * — an HTML or SVG attachment in its own tab — runs no script and reaches
 * nothing. Neither affects an `<img>` loading a raster image.
 */
const UNTRUSTED_CONTENT_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
};

function attachmentDisposition(filename: string): string {
  // Sanitize before interpolating into the header: a raw filename can carry
  // quotes or CR/LF and split the response. `filename*` (RFC 5987) carries the
  // full value for clients that honour it.
  const safeFilename = sanitizeFilename(filename).replaceAll('"', "_");
  return `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;
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
      "Content-Disposition": attachmentDisposition(att.filename),
      "Content-Length": att.size.toString(),
      "Cache-Control": "private, max-age=31536000, immutable",
      ...UNTRUSTED_CONTENT_HEADERS,
    },
  });
});

// Serve attachment inline (for CID images in email HTML)
const inlineRoute = createRoute({
  method: "get",
  path: "/{id}/inline",
  tags: ["Attachments"],
  description:
    "Serve an image attachment inline — embedded CID images and the image viewer. Only raster image types (PNG, JPEG, GIF, WebP, AVIF, BMP) are served with `Content-Disposition: inline`; anything else, SVG included, is served as a download. Scoped to the caller's allowed inboxes.",
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

  // Inline only for raster images. Anything else still loads in an `<img>`
  // (which ignores the disposition), but opened directly it downloads rather
  // than rendering on our origin.
  return new Response(object.body, {
    headers: {
      "Content-Type": att.contentType,
      "Content-Disposition": isInlineImageType(att.contentType)
        ? "inline"
        : attachmentDisposition(att.filename),
      "Content-Length": att.size.toString(),
      // `public` would let shared caches serve this mailbox content to another
      // caller.
      "Cache-Control": "private, max-age=31536000, immutable",
      ...UNTRUSTED_CONTENT_HEADERS,
    },
  });
});
