import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { users } from "../db/auth.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { InvalidCursorError } from "../lib/messages/cursor";
import {
  InvalidQueryError,
  queryMessages,
  type MessageFolder,
} from "../lib/messages/query";
import {
  parseMessageRef,
  serializeMessageRef,
  type MessageRef,
} from "../lib/messages/types";
import {
  InvalidMessageStateError,
  MessageStateAccessError,
  getMailbox,
  setMailboxMembership,
  setMailboxState,
  setUserState,
} from "../lib/messages/state";
import {
  assignConversations,
  snoozeConversations,
} from "../lib/messages/conversation-state";
import { isInboxAllowed } from "../lib/inbox-permissions";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const messagesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ErrorSchema = z.object({ error: z.string() });
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const BoolQuery = z.enum(["true", "false", "1", "0"]).optional();
function boolValue(value: z.infer<typeof BoolQuery>): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true" || value === "1";
}

const MessageStateSchema = z.object({
  seen: z.boolean(),
  starredAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  spamAt: z.number().nullable(),
  trashedAt: z.number().nullable(),
  mailboxIds: z.array(z.string()),
  conversationKey: z.string().nullable(),
  snoozedUntil: z.number().nullable(),
  assignedUserId: z.string().nullable(),
});

const MessageSchema = z.object({
  ref: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  inbox: z.string(),
  personId: z.string().nullable(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  from: z
    .object({ email: z.string(), name: z.string().nullable().optional() })
    .nullable(),
  to: z.object({
    email: z.string(),
    name: z.string().nullable().optional(),
  }),
  cc: z.array(
    z.object({ email: z.string(), name: z.string().nullable().optional() }),
  ),
  subject: z.string().nullable(),
  bodyText: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  occurredAt: z.number(),
  isRead: z.boolean().nullable(),
  source: z.object({
    campaignId: z.string().nullable(),
    sequenceId: z.string().nullable(),
    sequenceEnrollmentId: z.string().nullable(),
  }),
  delivery: z.object({ status: z.string() }).nullable(),
  attachmentCount: z.number().optional(),
  state: MessageStateSchema.optional(),
});

const AssigneeSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
});

const assigneesRoute = createRoute({
  method: "get",
  path: "/assignees",
  tags: ["Messages"],
  security: bearerSecurity,
  request: {
    query: z.object({ inbox: z.string().min(1) }),
  },
  responses: {
    200: {
      description: "Users who can be assigned conversations in an inbox",
      content: {
        "application/json": { schema: z.array(AssigneeSchema) },
      },
    },
    404: errorResponse("Inbox not found"),
  },
});

messagesRouter.openapi(assigneesRoute, async (c) => {
  const inbox = c.req.valid("query").inbox.trim().toLowerCase();
  const allowed = c.get("allowedInboxes")!;
  if (!isInboxAllowed(allowed, inbox)) {
    return c.json({ error: "Inbox not found" }, 404);
  }

  type AssigneeRow = {
    id: string;
    name: string;
    email: string;
    image: string | null;
  };

  const rows = await c.get("db").all<AssigneeRow>(sql`
    SELECT DISTINCT
      u.id AS id,
      u.name AS name,
      u.email AS email,
      u.image AS image
    FROM ${users} AS u
    LEFT JOIN ${inboxPermissions} AS ip
      ON ip.user_id = u.id
      AND lower(ip.email) = ${inbox}
    WHERE u.role = 'admin' OR ip.user_id IS NOT NULL
    ORDER BY u.name, u.email, u.id
  `);

  return c.json(rows, 200);
});

function parseRefs(values: string[]): MessageRef[] {
  return values.map((value) => {
    const ref = parseMessageRef(value);
    if (!ref) {
      throw new InvalidMessageStateError(`Invalid message ref: ${value}`);
    }
    return ref;
  });
}

function stateError(
  error: unknown,
): { status: 400 | 404; message: string } | null {
  if (error instanceof MessageStateAccessError) {
    return { status: 404, message: error.message };
  }
  if (
    error instanceof InvalidMessageStateError ||
    error instanceof InvalidQueryError ||
    error instanceof InvalidCursorError
  ) {
    return { status: 400, message: error.message };
  }
  return null;
}

const listMessagesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Messages"],
  security: bearerSecurity,
  description:
    "List unified received and sent messages with cursor pagination and optional mailbox state filters.",
  request: {
    query: z.object({
      inbox: z.string().optional(),
      folder: z
        .enum(["inbox", "sent", "archive", "junk", "trash", "snoozed"])
        .optional(),
      mailboxId: z.string().min(1).optional(),
      starred: BoolQuery,
      unseen: BoolQuery,
      includeTrashed: BoolQuery,
      includeSpam: BoolQuery,
      personId: z.string().optional(),
      q: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      excludeCampaignSends: BoolQuery,
      assignedTo: z.string().min(1).optional(),
    }),
  },
  responses: {
    200: {
      description: "Message page",
      content: {
        "application/json": {
          schema: z.object({
            messages: z.array(MessageSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    400: errorResponse("Invalid query"),
    404: errorResponse("Mailbox not found"),
  },
});

messagesRouter.openapi(listMessagesRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const user = c.get("user");
  const input = c.req.valid("query");

  try {
    if (input.folder && input.mailboxId) {
      throw new InvalidQueryError("folder and mailboxId cannot be combined");
    }

    let folder: MessageFolder | undefined = input.folder;
    if (input.mailboxId) {
      await getMailbox(db, allowed, input.mailboxId);
      folder = { mailboxId: input.mailboxId };
    }

    const excludeCampaignSends =
      boolValue(input.excludeCampaignSends) ??
      (input.folder === "sent" ? true : undefined);

    const page = await queryMessages(db, allowed, {
      inboxes: input.inbox ? [input.inbox] : undefined,
      folder,
      starred: boolValue(input.starred) ? true : undefined,
      unseen: boolValue(input.unseen) ? true : undefined,
      includeTrashed: boolValue(input.includeTrashed),
      includeSpam: boolValue(input.includeSpam),
      personId: input.personId,
      search: input.q,
      searchMode: input.q ? "fulltext" : undefined,
      cursor: input.cursor,
      limit: input.limit ?? 50,
      viewer: { userId: user.id },
      withState: true,
      withAttachmentCounts: true,
      excludeCampaignSends,
      assignedTo: input.assignedTo === "me" ? user.id : input.assignedTo,
    });

    return c.json(
      {
        messages: page.messages.map((message) => ({
          ...message,
          ref: serializeMessageRef(message.ref),
        })),
        nextCursor: page.nextCursor,
      },
      200,
    );
  } catch (error) {
    const mapped = stateError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});

const RefsSchema = z.array(z.string()).min(1).max(500);

const userStateRoute = createRoute({
  method: "post",
  path: "/user-state",
  tags: ["Messages"],
  security: bearerSecurity,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            refs: RefsSchema,
            seen: z.boolean().optional(),
            starred: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "State updated",
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
    },
    400: errorResponse("Invalid state"),
    404: errorResponse("Message not found"),
  },
});

messagesRouter.openapi(userStateRoute, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  try {
    await setUserState(c.get("db"), user.id, parseRefs(body.refs), {
      seen: body.seen,
      starred: body.starred,
    });
    return c.json({ success: true }, 200);
  } catch (error) {
    const mapped = stateError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});

const mailboxStateRoute = createRoute({
  method: "post",
  path: "/mailbox-state",
  tags: ["Messages"],
  security: bearerSecurity,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            refs: RefsSchema,
            archived: z.boolean().optional(),
            spam: z.boolean().optional(),
            trashed: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "State updated",
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
    },
    400: errorResponse("Invalid state"),
    404: errorResponse("Message not found"),
  },
});

messagesRouter.openapi(mailboxStateRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    await setMailboxState(
      c.get("db"),
      c.get("allowedInboxes")!,
      c.get("user").id,
      parseRefs(body.refs),
      {
        archived: body.archived,
        spam: body.spam,
        trashed: body.trashed,
      },
    );
    return c.json({ success: true }, 200);
  } catch (error) {
    const mapped = stateError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});

const snoozeRoute = createRoute({
  method: "post",
  path: "/snooze",
  tags: ["Messages"],
  security: bearerSecurity,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            refs: RefsSchema,
            until: z.number().int().nullable(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Conversation snooze state updated",
      content: {
        "application/json": {
          schema: z.object({ conversations: z.number().int().nonnegative() }),
        },
      },
    },
    400: errorResponse("Invalid snooze state"),
    404: errorResponse("Message not found"),
  },
});

messagesRouter.openapi(snoozeRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    const conversations = await snoozeConversations(
      c.get("db"),
      c.get("allowedInboxes")!,
      c.get("user").id,
      parseRefs(body.refs),
      body.until,
    );
    return c.json({ conversations }, 200);
  } catch (error) {
    const mapped = stateError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});

const assignRoute = createRoute({
  method: "post",
  path: "/assign",
  tags: ["Messages"],
  security: bearerSecurity,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            refs: RefsSchema,
            userId: z.string().min(1).nullable(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Conversation assignment updated",
      content: {
        "application/json": {
          schema: z.object({ conversations: z.number().int().nonnegative() }),
        },
      },
    },
    404: errorResponse("Message or assignee not found or not allowed"),
  },
});

messagesRouter.openapi(assignRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    const conversations = await assignConversations(
      c.get("db"),
      c.get("allowedInboxes")!,
      c.get("user").id,
      parseRefs(body.refs),
      body.userId,
    );
    return c.json({ conversations }, 200);
  } catch (error) {
    const mapped = stateError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});

const mailboxMembershipRoute = createRoute({
  method: "post",
  path: "/mailbox-membership",
  tags: ["Messages"],
  security: bearerSecurity,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            refs: RefsSchema,
            add: z.array(z.string()).optional(),
            remove: z.array(z.string()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Membership updated",
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
    },
    400: errorResponse("Invalid membership"),
    404: errorResponse("Message or mailbox not found"),
  },
});

messagesRouter.openapi(mailboxMembershipRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    await setMailboxMembership(
      c.get("db"),
      c.get("allowedInboxes")!,
      c.get("user").id,
      parseRefs(body.refs),
      { add: body.add, remove: body.remove },
    );
    return c.json({ success: true }, 200);
  } catch (error) {
    const mapped = stateError(error);
    if (mapped) return c.json({ error: mapped.message }, mapped.status);
    throw error;
  }
});
