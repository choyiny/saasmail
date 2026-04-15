import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Resend } from "resend";
import { createAuth } from "../auth";
import { senders } from "../db/senders.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { cancelSequencesForSender } from "../lib/cancel-sequence";
import { json200Response, json201Response } from "../lib/helpers";
import type { Variables } from "../variables";
import { injectDb } from "../db/middleware";

export const mcpRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// Inject DB for MCP routes (since they bypass /api/* middleware)
mcpRouter.use("*", injectDb);

// OAuth bearer token verification middleware
mcpRouter.use("*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing bearer token" }, 401);
  }

  const token = authHeader.slice(7);
  const auth = createAuth(c.env);

  try {
    const session = await auth.api.getSession({
      headers: new Headers({ Authorization: `Bearer ${token}` }),
    });

    if (!session) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    c.set("user", session.user);
    return next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
});

// --- LIST SENDERS ---
const listSendersRoute = createRoute({
  method: "get",
  path: "/senders",
  tags: ["MCP"],
  description: "List senders with optional search.",
  request: {
    query: z.object({
      q: z.string().optional(),
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    ...json200Response(z.array(z.any()), "List of senders"),
  },
});

mcpRouter.openapi(listSendersRoute, async (c) => {
  const db = c.get("db");
  const { q, page, limit } = c.req.valid("query");
  const pageNum = parseInt(page ?? "1");
  const limitNum = parseInt(limit ?? "50");
  const offset = (pageNum - 1) * limitNum;

  let rows;
  if (q) {
    rows = await db
      .select()
      .from(senders)
      .where(like(senders.email, `%${q}%`))
      .orderBy(senders.lastEmailAt)
      .limit(limitNum)
      .offset(offset);
  } else {
    rows = await db
      .select()
      .from(senders)
      .orderBy(senders.lastEmailAt)
      .limit(limitNum)
      .offset(offset);
  }

  return c.json(rows, 200);
});

// --- GET SENDER ---
const getSenderRoute = createRoute({
  method: "get",
  path: "/senders/{id}",
  tags: ["MCP"],
  description: "Get a single sender.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(z.any(), "Sender details"),
  },
});

mcpRouter.openapi(getSenderRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const rows = await db
    .select()
    .from(senders)
    .where(eq(senders.id, id))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Sender not found" }, 404);
  }

  return c.json(rows[0], 200);
});

// --- LIST EMAILS FOR SENDER ---
const listEmailsRoute = createRoute({
  method: "get",
  path: "/senders/{id}/emails",
  tags: ["MCP"],
  description: "List emails for a sender.",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    ...json200Response(z.array(z.any()), "List of emails"),
  },
});

mcpRouter.openapi(listEmailsRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const { page, limit } = c.req.valid("query");
  const pageNum = parseInt(page ?? "1");
  const limitNum = parseInt(limit ?? "50");
  const offset = (pageNum - 1) * limitNum;

  const received = await db
    .select()
    .from(emails)
    .where(eq(emails.senderId, id))
    .orderBy(emails.receivedAt)
    .limit(limitNum)
    .offset(offset);

  const sent = await db
    .select()
    .from(sentEmails)
    .where(eq(sentEmails.senderId, id))
    .orderBy(sentEmails.sentAt)
    .limit(limitNum);

  const combined = [
    ...received.map((e) => ({ ...e, type: "received" as const })),
    ...sent.map((e) => ({ ...e, type: "sent" as const })),
  ].sort((a, b) => {
    const aTime = "receivedAt" in a ? a.receivedAt : a.sentAt;
    const bTime = "receivedAt" in b ? b.receivedAt : b.sentAt;
    return bTime - aTime;
  });

  return c.json(combined, 200);
});

// --- READ EMAIL ---
const readEmailRoute = createRoute({
  method: "get",
  path: "/emails/{id}",
  tags: ["MCP"],
  description: "Read a single email with full body.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(z.any(), "Email details"),
  },
});

mcpRouter.openapi(readEmailRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const received = await db
    .select()
    .from(emails)
    .where(eq(emails.id, id))
    .limit(1);

  if (received.length > 0) {
    return c.json({ ...received[0], type: "received" }, 200);
  }

  const sent = await db
    .select()
    .from(sentEmails)
    .where(eq(sentEmails.id, id))
    .limit(1);

  if (sent.length > 0) {
    return c.json({ ...sent[0], type: "sent" }, 200);
  }

  return c.json({ error: "Email not found" }, 404);
});

// --- SEND EMAIL ---
const sendEmailRoute = createRoute({
  method: "post",
  path: "/send",
  tags: ["MCP"],
  description: "Compose and send a new email.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            to: z.string().email(),
            subject: z.string(),
            bodyHtml: z.string(),
            bodyText: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({ id: z.string(), status: z.string() }),
      "Email sent",
    ),
  },
});

mcpRouter.openapi(sendEmailRoute, async (c) => {
  const db = c.get("db");
  const { to, subject, bodyHtml, bodyText } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);
  const fromAddress = c.env.RESEND_EMAIL_FROM;

  const resend = new Resend(c.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: fromAddress,
    to,
    subject,
    html: bodyHtml,
    text: bodyText,
  });

  const existingSender = await db
    .select({ id: senders.id })
    .from(senders)
    .where(eq(senders.email, to))
    .limit(1);

  const senderId = existingSender[0]?.id ?? null;

  const id = nanoid();
  await db.insert(sentEmails).values({
    id,
    senderId,
    fromAddress,
    toAddress: to,
    subject,
    bodyHtml,
    bodyText: bodyText ?? null,
    resendId: result.data?.id ?? null,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  if (senderId) {
    await cancelSequencesForSender(db, senderId);
  }

  return c.json({ id, status: result.error ? "failed" : "sent" }, 201);
});

// --- REPLY EMAIL ---
const replyEmailRoute = createRoute({
  method: "post",
  path: "/send/reply/{emailId}",
  tags: ["MCP"],
  description: "Reply to a received email.",
  request: {
    params: z.object({ emailId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            bodyHtml: z.string(),
            bodyText: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({ id: z.string(), status: z.string() }),
      "Reply sent",
    ),
  },
});

mcpRouter.openapi(replyEmailRoute, async (c) => {
  const db = c.get("db");
  const { emailId } = c.req.valid("param");
  const { bodyHtml, bodyText } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);
  const fromAddress = c.env.RESEND_EMAIL_FROM;

  const original = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  if (original.length === 0) {
    return c.json({ error: "Email not found" }, 404);
  }

  const orig = original[0];

  const sender = await db
    .select({ email: senders.email })
    .from(senders)
    .where(eq(senders.id, orig.senderId))
    .limit(1);

  if (sender.length === 0) {
    return c.json({ error: "Sender not found" }, 404);
  }

  const toAddress = sender[0].email;
  const subject = orig.subject?.startsWith("Re: ")
    ? orig.subject
    : `Re: ${orig.subject || ""}`;

  const resend = new Resend(c.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: fromAddress,
    to: toAddress,
    subject,
    html: bodyHtml,
    text: bodyText,
    headers: orig.messageId ? { "In-Reply-To": orig.messageId } : undefined,
  });

  const id = nanoid();
  await db.insert(sentEmails).values({
    id,
    senderId: orig.senderId,
    fromAddress,
    toAddress,
    subject,
    bodyHtml,
    bodyText: bodyText ?? null,
    inReplyTo: orig.messageId,
    resendId: result.data?.id ?? null,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  await cancelSequencesForSender(db, orig.senderId);

  return c.json({ id, status: result.error ? "failed" : "sent" }, 201);
});

// --- MARK READ/UNREAD ---
const markReadRoute = createRoute({
  method: "patch",
  path: "/emails/{id}",
  tags: ["MCP"],
  description: "Mark an email as read or unread.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ isRead: z.boolean() }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Updated"),
  },
});

mcpRouter.openapi(markReadRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const { isRead } = c.req.valid("json");

  await db
    .update(emails)
    .set({ isRead: isRead ? 1 : 0 })
    .where(eq(emails.id, id));

  return c.json({ success: true }, 200);
});

// --- DELETE EMAIL ---
const deleteEmailRoute = createRoute({
  method: "delete",
  path: "/emails/{id}",
  tags: ["MCP"],
  description: "Delete an email.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Deleted"),
  },
});

mcpRouter.openapi(deleteEmailRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const received = await db
    .select({ id: emails.id })
    .from(emails)
    .where(eq(emails.id, id))
    .limit(1);

  if (received.length > 0) {
    await db.delete(emails).where(eq(emails.id, id));
    return c.json({ success: true }, 200);
  }

  const sent = await db
    .select({ id: sentEmails.id })
    .from(sentEmails)
    .where(eq(sentEmails.id, id))
    .limit(1);

  if (sent.length > 0) {
    await db.delete(sentEmails).where(eq(sentEmails.id, id));
    return c.json({ success: true }, 200);
  }

  return c.json({ error: "Email not found" }, 404);
});
