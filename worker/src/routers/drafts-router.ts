import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { drafts } from "../db/drafts.schema";
import { agentRuns } from "../db/agent-runs.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createEmailSender } from "../lib/email-sender";
import { generateMessageId } from "../lib/message-id";
import { formatFromAddress } from "../lib/format-from-address";
import { json200Response } from "../lib/helpers";
import { draftResponse } from "./agents-schemas";
import type { Variables } from "../variables";

export const draftsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Drafts"],
  description: "List pending agent drafts.",
  request: {
    query: z.object({ personId: z.string().optional() }),
  },
  responses: {
    ...json200Response(z.array(draftResponse), "Draft list"),
  },
});

draftsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const { personId } = c.req.valid("query");
  const rows = await db
    .select()
    .from(drafts)
    .where(personId ? eq(drafts.personId, personId) : undefined)
    .orderBy(desc(drafts.createdAt));
  return c.json(
    rows.map((r) => ({
      ...r,
      bodyHtml: r.bodyHtml ?? null,
      inReplyTo: r.inReplyTo ?? null,
    })),
    200,
  );
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Drafts"],
  description: "Get a draft by ID.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(draftResponse, "Draft"),
  },
});

draftsRouter.openapi(getRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const rows = await db.select().from(drafts).where(eq(drafts.id, id)).limit(1);
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  const r = rows[0];
  return c.json(
    { ...r, bodyHtml: r.bodyHtml ?? null, inReplyTo: r.inReplyTo ?? null },
    200,
  );
});

const sendRoute = createRoute({
  method: "post",
  path: "/{id}/send",
  tags: ["Drafts"],
  description: "Promote a draft to a sent email.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ sentEmailId: z.string() }), "Sent"),
  },
});

draftsRouter.openapi(sendRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const rows = await db.select().from(drafts).where(eq(drafts.id, id)).limit(1);
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  const draft = rows[0];

  const sender = createEmailSender(c.env);
  const messageId = generateMessageId(draft.fromAddress);
  const formattedFrom = await formatFromAddress(db, draft.fromAddress);

  const result = await sender.send({
    from: formattedFrom,
    to: draft.toAddress,
    subject: draft.subject,
    html: draft.bodyHtml ?? "",
    headers: {
      "Message-ID": messageId,
      "Auto-Submitted": "auto-replied",
      ...(draft.inReplyTo ? { "In-Reply-To": draft.inReplyTo } : {}),
    },
  });

  if (result.error) {
    return c.json({ error: `Send failed: ${result.error}` }, 500);
  }

  const now = Math.floor(Date.now() / 1000);
  const sentId = nanoid();
  await db.insert(sentEmails).values({
    id: sentId,
    personId: draft.personId,
    fromAddress: draft.fromAddress,
    toAddress: draft.toAddress,
    subject: draft.subject,
    bodyHtml: draft.bodyHtml,
    bodyText: null,
    inReplyTo: draft.inReplyTo,
    messageId,
    resendId: result.id,
    status: "sent",
    sentAt: now,
    createdAt: now,
  });

  await db
    .update(agentRuns)
    .set({ action: "sent", sentEmailId: sentId, draftId: null, updatedAt: now })
    .where(eq(agentRuns.id, draft.agentRunId));

  await db.delete(drafts).where(eq(drafts.id, id));

  return c.json({ sentEmailId: sentId }, 200);
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Drafts"],
  description: "Discard a draft.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Deleted"),
  },
});

draftsRouter.openapi(deleteRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const rows = await db.select().from(drafts).where(eq(drafts.id, id)).limit(1);
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  await db.delete(drafts).where(eq(drafts.id, id));
  return c.json({ success: true }, 200);
});
