import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { suppressions } from "../db/suppressions.schema";
import {
  applyListUnsubscribe,
  undoListUnsubscribe,
} from "../lib/list-unsubscribe";
import { verifyUnsubscribeToken } from "../lib/unsubscribe-token";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const unsubscribeRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// --- Schemas ---

const UnsubscribeResponseSchema = z.object({
  email: z.string(),
  status: z.enum(["suppressed", "subscribed"]),
  /**
   * Which unsubscribe happened. `global` is a suppression covering every
   * future send; `list` removes one list membership and leaves the address
   * otherwise mailable. v1 tokens are always global, v2 always list-scoped.
   */
  scope: z.enum(["global", "list"]),
  listId: z.string().nullable(),
});

const ErrorSchema = z.object({ error: z.string() });

// --- POST /api/unsubscribe ---
//
// Public, token-authenticated endpoint. Used for both List-Unsubscribe
// one-click POSTs (RFC 8058) and user-driven links in email bodies.
// Idempotent in both scopes: replaying a token neither duplicates rows nor
// overwrites the original `source`.

const unsubscribeRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Unsubscribe"],
  description:
    "Record an unsubscribe from a signed token — a global suppression (v1 token) or a single list membership (v2 token). Idempotent.",
  request: {
    query: z.object({
      token: z.string(),
      source: z.enum(["one-click", "user-link"]).optional(),
    }),
  },
  responses: {
    ...json200Response(
      UnsubscribeResponseSchema,
      "Unsubscribe recorded (or already present)",
    ),
    401: {
      description: "Invalid or tampered token",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

unsubscribeRouter.openapi(unsubscribeRoute, async (c) => {
  const { token, source } = c.req.valid("query");

  const result = await verifyUnsubscribeToken(token, c.env.UNSUBSCRIBE_SECRET);
  if (!result) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const db = c.get("db");

  if (result.version === 2) {
    const outcome = await applyListUnsubscribe(db, result, {
      reason: source ?? "one-click",
    });
    // A token whose campaign no longer matches its list, or whose membership
    // is gone, is answered exactly like a forged one — the caller is a mail
    // client or a stranger with a forwarded link, and neither should be able
    // to probe which lists or campaigns exist.
    if (outcome.error !== null) {
      return c.json({ error: "Invalid token" }, 401);
    }
    return c.json(
      {
        email: outcome.email!,
        status: "suppressed" as const,
        scope: "list" as const,
        listId: outcome.listId!,
      },
      200,
    );
  }

  const email = result.email.toLowerCase();

  const existing = await db
    .select()
    .from(suppressions)
    .where(eq(suppressions.email, email))
    .limit(1);

  if (existing.length > 0) {
    // Idempotent — do not overwrite the original source/note.
    return c.json(
      {
        email,
        status: "suppressed" as const,
        scope: "global" as const,
        listId: null,
      },
      200,
    );
  }

  await db
    .insert(suppressions)
    .values({
      id: nanoid(),
      email,
      reason: "unsubscribe",
      source: source ?? "one-click",
      note: null,
      createdAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoNothing({ target: suppressions.email });

  return c.json(
    {
      email,
      status: "suppressed" as const,
      scope: "global" as const,
      listId: null,
    },
    200,
  );
});

// --- POST /api/unsubscribe/undo ---
//
// Public, token-authenticated endpoint. Reverses the unsubscribe the same
// token performed. Idempotent — undoing something already undone succeeds.
//
// v2 undo is time-boxed (see RESUBSCRIBE_UNDO_WINDOW_SECONDS): past the
// window this answers 410, and the way back onto the list is a fresh opt-in
// through the public form.

const undoRoute = createRoute({
  method: "post",
  path: "/undo",
  tags: ["Unsubscribe"],
  description:
    "Reverse an unsubscribe via signed token — removes the global suppression (v1) or restores the list membership within the undo window (v2). Idempotent.",
  request: {
    query: z.object({
      token: z.string(),
    }),
  },
  responses: {
    ...json200Response(
      UnsubscribeResponseSchema,
      "Unsubscribe reversed (or already reversed)",
    ),
    401: {
      description: "Invalid or tampered token",
      content: { "application/json": { schema: ErrorSchema } },
    },
    410: {
      description: "The re-subscribe window has closed; opt in again instead",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

unsubscribeRouter.openapi(undoRoute, async (c) => {
  const { token } = c.req.valid("query");

  const result = await verifyUnsubscribeToken(token, c.env.UNSUBSCRIBE_SECRET);
  if (!result) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const db = c.get("db");

  if (result.version === 2) {
    const outcome = await undoListUnsubscribe(db, result);
    if (outcome.error !== null) {
      return outcome.error === "window_closed"
        ? c.json({ error: "Re-subscribe window has closed" }, 410)
        : c.json({ error: "Invalid token" }, 401);
    }
    return c.json(
      {
        email: outcome.email!,
        status: "subscribed" as const,
        scope: "list" as const,
        listId: outcome.listId!,
      },
      200,
    );
  }

  const email = result.email.toLowerCase();
  await db.delete(suppressions).where(eq(suppressions.email, email));

  return c.json(
    {
      email,
      status: "subscribed" as const,
      scope: "global" as const,
      listId: null,
    },
    200,
  );
});
