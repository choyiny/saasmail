import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { SCOPE_READ, SCOPE_MANAGE, hasScope } from "../auth/scopes";
import { listPeople, getPersonScoped } from "../lib/queries/people";
import {
  listPersonEmails,
  getEmailById,
  setEmailRead,
} from "../lib/queries/emails";
import { deleteEmailWithAttachments } from "../lib/delete-email";

export interface McpUser {
  id: string;
  name: string;
  email: string;
  role: string | null;
}

export interface McpContext {
  db: DrizzleD1Database<any>;
  env: CloudflareBindings;
  user: McpUser;
  allowed: AllowedInboxes;
  /** Scopes carried by the access token that authenticated this request. */
  scopes: string[];
}

/** A successful tool result: JSON, pretty-printed, as text content. */
export function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** A failed tool result. MCP reports errors in-band, not as transport errors. */
export function fail(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Wraps a tool handler with scope enforcement and error translation.
 *
 * Two things must not escape into the transport: a missing scope (the client
 * should be told which one it needs, not get a protocol error), and the Hono
 * `HTTPException` that `assertInboxAllowed` throws — it carries an HTTP status
 * that means nothing over MCP.
 */
function guard<Args extends unknown[]>(
  ctx: McpContext,
  requiredScope: string,
  run: (...args: Args) => Promise<ReturnType<typeof ok>>,
) {
  return async (...args: Args) => {
    if (!hasScope(ctx.scopes, requiredScope)) {
      return fail(
        `This tool requires the "${requiredScope}" scope, which this token was not granted.`,
      );
    }
    try {
      return await run(...args);
    } catch (e) {
      if (e instanceof HTTPException) return fail(e.message);
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

/**
 * Denials are reported as not-found so a caller cannot use these tools to
 * probe for the existence of ids outside its inboxes. Mirrors the HTTP API.
 */
const NOT_FOUND = "Not found, or outside the inboxes you may access.";

const pagination = {
  page: z.number().int().min(1).optional().describe("1-based page. Default 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Results per page. Default 50."),
};

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "saasmail", version: "1.0.0" });
  const { db, allowed } = ctx;

  server.registerTool(
    "whoami",
    {
      description:
        "Identify the authenticated user and report which inboxes this connection may act on. Call this first: every other tool is scoped to these inboxes, and sends must come from one of them.",
      annotations: { readOnlyHint: true, title: "Who Am I" },
      inputSchema: {},
    },
    guard(ctx, SCOPE_READ, async () =>
      ok({
        userId: ctx.user.id,
        name: ctx.user.name,
        email: ctx.user.email,
        role: ctx.user.role,
        inboxes: allowed.isAdmin ? "all" : allowed.inboxes,
        scopes: ctx.scopes,
      }),
    ),
  );

  server.registerTool(
    "list_people",
    {
      description:
        "List contacts, most recently active first. Each row is a (person, inbox) pair — the same person appears once per inbox they have corresponded with. Use the returned person id with list_emails.",
      annotations: { readOnlyHint: true, title: "List People" },
      inputSchema: {
        q: z
          .string()
          .optional()
          .describe("Filter by email address or name substring."),
        recipient: z
          .string()
          .optional()
          .describe("Only people who corresponded with this inbox address."),
        ...pagination,
      },
    },
    guard(ctx, SCOPE_READ, async (input) =>
      ok(
        await listPeople(
          db,
          {
            q: input.q,
            recipient: input.recipient,
            page: input.page ?? 1,
            limit: input.limit ?? 50,
          },
          allowed,
        ),
      ),
    ),
  );

  server.registerTool(
    "get_person",
    {
      description:
        "Fetch a single contact by id, including unread and total message counts.",
      annotations: { readOnlyHint: true, title: "Get Person" },
      inputSchema: {
        personId: z.string().describe("Person id, from list_people."),
      },
    },
    guard(ctx, SCOPE_READ, async ({ personId }) => {
      const person = await getPersonScoped(db, personId, allowed);
      return person ? ok(person) : fail(NOT_FOUND);
    }),
  );

  server.registerTool(
    "list_emails",
    {
      description:
        "List a contact's messages, received and sent interleaved chronologically, with attachment metadata. Bodies are included; use read_email for a single message with its Reply-To.",
      annotations: { readOnlyHint: true, title: "List Emails" },
      inputSchema: {
        personId: z.string().describe("Person id, from list_people."),
        q: z.string().optional().describe("Filter by subject substring."),
        recipient: z
          .string()
          .optional()
          .describe("Only messages for this inbox address."),
        ...pagination,
      },
    },
    guard(ctx, SCOPE_READ, async (input) =>
      ok(
        await listPersonEmails(
          db,
          input.personId,
          {
            q: input.q,
            recipient: input.recipient,
            page: input.page ?? 1,
            limit: input.limit ?? 50,
          },
          allowed,
        ),
      ),
    ),
  );

  server.registerTool(
    "read_email",
    {
      description:
        "Read one message in full by id. Works for both received and sent messages — the `type` field says which. Received messages surface a Reply-To address when it differs from the contact.",
      annotations: { readOnlyHint: true, title: "Read Email" },
      inputSchema: {
        emailId: z.string().describe("Email id, from list_emails."),
      },
    },
    guard(ctx, SCOPE_READ, async ({ emailId }) => {
      const email = await getEmailById(db, emailId, allowed);
      return email ? ok(email) : fail(NOT_FOUND);
    }),
  );

  server.registerTool(
    "mark_read",
    {
      description:
        "Mark a received message read or unread. The contact's unread count is adjusted to match.",
      annotations: { readOnlyHint: false, title: "Mark Read" },
      inputSchema: {
        emailId: z.string().describe("Email id, from list_emails."),
        isRead: z
          .boolean()
          .describe("true to mark read, false to mark unread."),
      },
    },
    guard(ctx, SCOPE_MANAGE, async ({ emailId, isRead }) => {
      const result = await setEmailRead(db, emailId, isRead, allowed);
      return result ? ok({ success: true, emailId, isRead }) : fail(NOT_FOUND);
    }),
  );

  server.registerTool(
    "delete_email",
    {
      description:
        "Permanently delete a message and its attachments. Works for received and sent messages. This cannot be undone — there is no trash — so confirm with the user before calling it.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        title: "Delete Email",
      },
      inputSchema: {
        emailId: z.string().describe("Email id, from list_emails."),
      },
    },
    guard(ctx, SCOPE_MANAGE, async ({ emailId }) => {
      const result = await deleteEmailWithAttachments(
        db,
        ctx.env.R2,
        emailId,
        allowed,
      );
      return result ? ok(result) : fail(NOT_FOUND);
    }),
  );

  return server;
}
