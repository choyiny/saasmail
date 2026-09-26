import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { agentSessions } from "../db/agent-sessions.schema";
import { resolveRequestAuth } from "../lib/request-auth";
import { passkeyRequired } from "../middleware/require-passkey";
import { mailAgentSessionIdForUser } from "./identity";

type AgentRoute = {
  className: string;
  name: string;
};

export async function authorizeMailAgentRequest(
  request: Request,
  route: AgentRoute,
  env: CloudflareBindings,
  db: DrizzleD1Database<any>,
): Promise<Response | void> {
  if (route.className !== "MAIL_AGENT") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await resolveRequestAuth(request, env, db);
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (await passkeyRequired(env, db, auth.user, auth.authMethod)) {
    return Response.json(
      { error: "Passkey registration required", code: "PASSKEY_REQUIRED" },
      { status: 403 },
    );
  }

  const sessionId = mailAgentSessionIdForUser(route.name, auth.user.id);
  if (!sessionId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.userId, auth.user.id),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return Response.json({ error: "Agent session not found" }, { status: 404 });
  }
}
