import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../db/emails.schema";
import { suggestedReplies } from "../db/suggested-replies.schema";
import { isInboxAllowed, type AllowedInboxes } from "../lib/inbox-permissions";
import { json200Response } from "../lib/helpers";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const suggestedRepliesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const SuggestedReplySchema = z.object({
  id: z.string(),
  emailId: z.string(),
  inbox: z.string(),
  bodyText: z.string(),
  model: z.string(),
  status: z.enum(["pending", "used", "dismissed"]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const ErrorSchema = z.object({ error: z.string() });
const notFound = {
  description: "Message or suggested reply not found",
  content: { "application/json": { schema: ErrorSchema } },
};

const getRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Suggested Replies"],
  security: bearerSecurity,
  request: {
    query: z.object({ emailId: z.string().min(1) }),
  },
  responses: {
    ...json200Response(
      z.object({ suggestion: SuggestedReplySchema.nullable() }),
      "Pending suggested reply, or null",
    ),
    404: notFound,
  },
});

suggestedRepliesRouter.openapi(getRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { emailId } = c.req.valid("query");

  const [email] = await db
    .select({ inbox: emails.recipient })
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);
  if (!email || !isInboxAllowed(allowed, email.inbox)) {
    return c.json({ error: "not found" }, 404);
  }

  const [suggestion] = await db
    .select()
    .from(suggestedReplies)
    .where(
      and(
        eq(suggestedReplies.emailId, emailId),
        eq(suggestedReplies.status, "pending"),
      ),
    )
    .limit(1);

  return c.json({ suggestion: suggestion ?? null }, 200);
});

async function loadAllowedSuggestion(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  id: string,
) {
  const [suggestion] = await db
    .select()
    .from(suggestedReplies)
    .where(eq(suggestedReplies.id, id))
    .limit(1);
  if (!suggestion || !isInboxAllowed(allowed, suggestion.inbox)) return null;
  return suggestion;
}

const transitionResponses = {
  ...json200Response(SuggestedReplySchema, "Updated suggested reply"),
  404: notFound,
  409: {
    description: "Suggested reply is already in the opposite terminal state",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

const useRoute = createRoute({
  method: "post",
  path: "/{id}/use",
  tags: ["Suggested Replies"],
  security: bearerSecurity,
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: transitionResponses,
});

suggestedRepliesRouter.openapi(useRoute, async (c) => {
  const { id } = c.req.valid("param");
  const suggestion = await loadAllowedSuggestion(
    c.get("db"),
    c.get("allowedInboxes")!,
    id,
  );
  if (!suggestion) return c.json({ error: "not found" }, 404);
  if (suggestion.status === "dismissed") {
    return c.json({ error: "dismissed suggestions cannot be used" }, 409);
  }
  if (suggestion.status === "used") return c.json(suggestion, 200);

  const now = Math.floor(Date.now() / 1000);
  const [updated] = await c
    .get("db")
    .update(suggestedReplies)
    .set({ status: "used", updatedAt: now })
    .where(eq(suggestedReplies.id, id))
    .returning();
  return c.json(updated, 200);
});

const dismissRoute = createRoute({
  method: "post",
  path: "/{id}/dismiss",
  tags: ["Suggested Replies"],
  security: bearerSecurity,
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: transitionResponses,
});

suggestedRepliesRouter.openapi(dismissRoute, async (c) => {
  const { id } = c.req.valid("param");
  const suggestion = await loadAllowedSuggestion(
    c.get("db"),
    c.get("allowedInboxes")!,
    id,
  );
  if (!suggestion) return c.json({ error: "not found" }, 404);
  if (suggestion.status === "used") {
    return c.json({ error: "used suggestions cannot be dismissed" }, 409);
  }
  if (suggestion.status === "dismissed") return c.json(suggestion, 200);

  const now = Math.floor(Date.now() / 1000);
  const [updated] = await c
    .get("db")
    .update(suggestedReplies)
    .set({ status: "dismissed", updatedAt: now })
    .where(eq(suggestedReplies.id, id))
    .returning();
  return c.json(updated, 200);
});
