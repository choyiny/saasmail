import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { SCOPE_READ, SCOPE_SEND, SCOPE_MANAGE, hasScope } from "../auth/scopes";
import { sendTemplate } from "../lib/send-template";
import { enrollPersonInSequence } from "../lib/enroll-sequence";
import { listPeople, getPersonScoped } from "../lib/queries/people";
import {
  listPersonEmails,
  getEmailById,
  setEmailRead,
} from "../lib/queries/emails";
import { deleteEmailWithAttachments } from "../lib/delete-email";
import { searchEmails } from "../lib/queries/search";

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
  /** null for tools every token may call regardless of granted scopes. */
  requiredScope: string | null,
  run: (...args: Args) => Promise<ReturnType<typeof ok>>,
) {
  return async (...args: Args) => {
    if (requiredScope !== null && !hasScope(ctx.scopes, requiredScope)) {
      return fail(
        `This tool requires the "${requiredScope}" scope, which this token was not granted.`,
      );
    }
    try {
      return await run(...args);
    } catch (e) {
      // HTTPException is deliberate and safe to echo — it is our own
      // permission message. Anything else is a bug, and its message may carry
      // SQL fragments, column names, or stored row content. The MCP client is
      // third-party software the operator never vetted, so log the detail and
      // return an opaque failure.
      if (e instanceof HTTPException) return fail(e.message);
      console.error("[mcp] tool failed:", e);
      return fail("The request could not be completed.");
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
    // Deliberately ungated: this is the only way to discover a valid
    // fromAddress, and both send tools tell the model to call it. Gating it on
    // email:read would leave a least-privilege send-only token unable to send
    // at all. It discloses nothing beyond the token's own identity and grants.
    guard(ctx, null, async () =>
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
    "search_emails",
    {
      description:
        "Full-text search across received and sent mail, newest first. Use this to find messages when you don't already know the contact — otherwise list_emails is cheaper. Returns a body excerpt per hit; call read_email for the full message.",
      annotations: { readOnlyHint: true, title: "Search Emails" },
      inputSchema: {
        q: z
          .string()
          .min(1)
          .describe("Words to search for in subject and body."),
        inbox: z.string().optional().describe("Restrict to one inbox address."),
        personId: z.string().optional().describe("Restrict to one contact."),
        after: z
          .number()
          .int()
          .optional()
          .describe("Only messages at or after this Unix timestamp (seconds)."),
        before: z
          .number()
          .int()
          .optional()
          .describe(
            "Only messages at or before this Unix timestamp (seconds).",
          ),
        ...pagination,
      },
    },
    guard(ctx, SCOPE_READ, async (input) => {
      const limit = input.limit ?? 50;
      const page = input.page ?? 1;
      return ok(
        await searchEmails(
          db,
          {
            q: input.q,
            inbox: input.inbox,
            personId: input.personId,
            after: input.after,
            before: input.before,
            limit,
            offset: (page - 1) * limit,
          },
          allowed,
        ),
      );
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

  server.registerTool(
    "send_template",
    {
      description:
        "Send a saved template to one recipient, interpolating its {{variables}}. fromAddress must be an inbox you may send from — call whoami to see which. Attachments and cc are not supported here.",
      annotations: { readOnlyHint: false, title: "Send Template" },
      inputSchema: {
        slug: z.string().describe("Template slug."),
        to: z.email().describe("Recipient email address."),
        fromAddress: z
          .string()
          .describe("Sender identity; must be one of your allowed inboxes."),
        variables: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Values for the template's {{placeholders}}. Missing ones are reported back with the full required list.",
          ),
      },
    },
    guard(ctx, SCOPE_SEND, async (input) => {
      const result = await sendTemplate({
        db,
        env: ctx.env,
        slug: input.slug,
        to: input.to,
        fromAddress: input.fromAddress,
        variables: input.variables ?? {},
        allowed,
      });
      if (!result.ok) {
        // Hand the model the required-variable list so it can retry correctly
        // rather than guessing at what was missing.
        return result.code === "MISSING_VARIABLES"
          ? fail(
              `${result.message} Missing: ${result.missingVariables.join(", ")}. Required: ${result.requiredVariables.join(", ")}.`,
            )
          : fail(result.message);
      }
      return ok(result);
    }),
  );

  server.registerTool(
    "enroll_sequence",
    {
      description:
        "Enrol a contact into a drip sequence. The first step sends immediately and later steps are scheduled from it. A contact can only be in one active sequence at a time, and sending them direct mail cancels it.",
      annotations: { readOnlyHint: false, title: "Enroll In Sequence" },
      inputSchema: {
        sequenceId: z.string().describe("Sequence id."),
        personEmail: z
          .email()
          .optional()
          .describe("Recipient address; the contact is created if new."),
        personId: z
          .string()
          .optional()
          .describe("Existing contact id. Use instead of personEmail."),
        fromAddress: z
          .string()
          .describe("Sender identity; must be one of your allowed inboxes."),
        variables: z
          .record(z.string(), z.string())
          .optional()
          .describe("Values for placeholders used by the sequence templates."),
        skipSteps: z
          .array(z.number().int())
          .optional()
          .describe("Step `order` numbers to skip entirely."),
        delayOverrides: z
          .record(z.string(), z.number())
          .optional()
          .describe(
            "Map of step order (as a string) to hours, overriding that step's delay. The first step always sends immediately.",
          ),
      },
    },
    guard(ctx, SCOPE_SEND, async (input) => {
      // The HTTP route expresses this as a Zod .refine() on the whole object;
      // an MCP inputSchema is a bare shape with no cross-field validation, so
      // without this the lib would query `people.email = undefined` and then
      // insert a row violating a NOT NULL constraint.
      if (!input.personId && !input.personEmail) {
        return fail("Provide either personEmail or personId.");
      }
      const result = await enrollPersonInSequence({
        db,
        env: ctx.env,
        sequenceId: input.sequenceId,
        input: {
          personId: input.personId,
          personEmail: input.personEmail,
          fromAddress: input.fromAddress,
          variables: input.variables ?? {},
          skipSteps: input.skipSteps ?? [],
          delayOverrides: input.delayOverrides ?? {},
        },
        allowed,
      });
      return result.ok ? ok(result) : fail(result.message);
    }),
  );

  return server;
}
