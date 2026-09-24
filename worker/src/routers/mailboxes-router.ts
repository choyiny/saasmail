import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { mailboxes as mailboxTable } from "../db/mailboxes.schema";
import { rules } from "../db/rules.schema";
import {
  InvalidMessageStateError,
  MessageStateAccessError,
  createMailbox,
  deleteMailbox,
  listMailboxes,
  updateMailbox,
} from "../lib/messages/state";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const mailboxesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ErrorSchema = z.object({ error: z.string() });
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const MailboxSchema = z.object({
  id: z.string(),
  inbox: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  parentId: z.string().nullable(),
  sortOrder: z.number(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  ruleCount: z.number().int().nonnegative(),
});

async function withRuleCounts(
  db: DrizzleD1Database<any>,
  rows: Array<typeof mailboxTable.$inferSelect>,
) {
  const storedRules = await db
    .select({ id: rules.id, actions: rules.actions })
    .from(rules);
  const counts = new Map<string, number>();
  for (const rule of storedRules) {
    const targeted = new Set(
      rule.actions
        .filter((action) => action.type === "move_to_folder")
        .map((action) => action.mailboxId),
    );
    for (const mailboxId of targeted) {
      counts.set(mailboxId, (counts.get(mailboxId) ?? 0) + 1);
    }
  }
  return rows.map((row) => ({ ...row, ruleCount: counts.get(row.id) ?? 0 }));
}

function isDuplicateMailboxError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const message =
      current instanceof Error ? current.message : String(current);
    if (
      message.includes("UNIQUE constraint failed") ||
      message.includes("SQLITE_CONSTRAINT_UNIQUE")
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

function mappedError(
  error: unknown,
): { status: 400 | 404 | 409; message: string } | null {
  if (error instanceof MessageStateAccessError) {
    return { status: 404, message: error.message };
  }
  if (error instanceof InvalidMessageStateError) {
    return { status: 400, message: error.message };
  }
  if (isDuplicateMailboxError(error)) {
    return { status: 409, message: "A mailbox with that name already exists" };
  }
  return null;
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Mailboxes"],
  security: bearerSecurity,
  request: { query: z.object({ inbox: z.string().optional() }) },
  responses: {
    200: {
      description: "Mailboxes",
      content: {
        "application/json": {
          schema: z.object({ mailboxes: z.array(MailboxSchema) }),
        },
      },
    },
    404: errorResponse("Inbox not found or not allowed"),
  },
});

mailboxesRouter.openapi(listRoute, async (c) => {
  try {
    const rows = await listMailboxes(
      c.get("db"),
      c.get("allowedInboxes")!,
      c.req.valid("query").inbox,
    );
    const mailboxes = [...rows].sort(
      (a, b) =>
        a.inbox.localeCompare(b.inbox) ||
        (a.parentId ?? "").localeCompare(b.parentId ?? "") ||
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name),
    );
    return c.json(
      { mailboxes: await withRuleCounts(c.get("db"), mailboxes) },
      200,
    );
  } catch (error) {
    const mapped = mappedError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});

const createRouteDefinition = createRoute({
  method: "post",
  path: "/",
  tags: ["Mailboxes"],
  security: bearerSecurity,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            inbox: z.string().min(1),
            name: z.string().min(1),
            parentId: z.string().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Mailbox created",
      content: { "application/json": { schema: MailboxSchema } },
    },
    400: errorResponse("Invalid mailbox"),
    404: errorResponse("Inbox or parent not found"),
    409: errorResponse("Duplicate mailbox name"),
  },
});

mailboxesRouter.openapi(createRouteDefinition, async (c) => {
  const body = c.req.valid("json");
  try {
    const mailbox = await createMailbox(
      c.get("db"),
      c.get("allowedInboxes")!,
      c.get("user").id,
      body,
    );
    const [result] = await withRuleCounts(c.get("db"), [mailbox]);
    return c.json(result!, 200);
  } catch (error) {
    const mapped = mappedError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Mailboxes"],
  security: bearerSecurity,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            sortOrder: z.number().int().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Mailbox updated",
      content: { "application/json": { schema: MailboxSchema } },
    },
    400: errorResponse("Invalid mailbox"),
    404: errorResponse("Mailbox not found"),
    409: errorResponse("Duplicate mailbox name"),
  },
});

mailboxesRouter.openapi(patchRoute, async (c) => {
  try {
    const mailbox = await updateMailbox(
      c.get("db"),
      c.get("allowedInboxes")!,
      c.get("user").id,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    const [result] = await withRuleCounts(c.get("db"), [mailbox]);
    return c.json(result!, 200);
  } catch (error) {
    const mapped = mappedError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Mailboxes"],
  security: bearerSecurity,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Mailbox deleted",
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
    },
    404: errorResponse("Mailbox not found"),
  },
});

mailboxesRouter.openapi(deleteRoute, async (c) => {
  try {
    await deleteMailbox(
      c.get("db"),
      c.get("allowedInboxes")!,
      c.get("user").id,
      c.req.valid("param").id,
    );
    return c.json({ success: true }, 200);
  } catch (error) {
    const mapped = mappedError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});
