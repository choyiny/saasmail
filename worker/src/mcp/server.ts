import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPException } from "hono/http-exception";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { SCOPE_READ, hasScope } from "../auth/scopes";

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
export function guard<Args extends unknown[]>(
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

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "saasmail", version: "1.0.0" });

  server.registerTool(
    "whoami",
    {
      description:
        "Identify the authenticated user and report which inboxes this connection may act on. Call this first to discover the sender addresses available to you.",
      annotations: { readOnlyHint: true, title: "Who Am I" },
      inputSchema: {},
    },
    guard(ctx, SCOPE_READ, async () =>
      ok({
        userId: ctx.user.id,
        name: ctx.user.name,
        email: ctx.user.email,
        role: ctx.user.role,
        inboxes: ctx.allowed.isAdmin ? "all" : ctx.allowed.inboxes,
        scopes: ctx.scopes,
      }),
    ),
  );

  return server;
}
