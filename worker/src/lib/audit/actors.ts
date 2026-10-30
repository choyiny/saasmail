import type { AuditActor } from "./context";

/** The caller's address and client, for the HTTP channels. */
function requestMeta(
  request: Request | undefined,
): Pick<AuditActor, "ip" | "userAgent"> {
  return {
    ip: request?.headers.get("cf-connecting-ip") ?? null,
    userAgent: request?.headers.get("user-agent") ?? null,
  };
}

type Person = { id: string; email?: string | null; name?: string | null };

function personLabel(user: Person): string {
  return user.email || user.name || user.id;
}

/**
 * An HTTP request nobody has authenticated yet (a public link, the sign-in
 * endpoints). The authenticated boundaries replace it with a named actor.
 */
export function anonymousHttpActor(request: Request): AuditActor {
  return {
    actorType: "system",
    actorUserId: null,
    actorLabel: "anonymous",
    channel: "web",
    ...requestMeta(request),
  };
}

/**
 * A signed-in person using the web app. When an admin is acting as that
 * person, the admin is the actor and the label says both.
 */
export function userActor(
  user: Person,
  request?: Request,
  impersonatedBy?: Person | null,
): AuditActor {
  return {
    actorType: "user",
    actorUserId: impersonatedBy ? impersonatedBy.id : user.id,
    actorLabel: impersonatedBy
      ? `${personLabel(impersonatedBy)} as ${personLabel(user)}`
      : personLabel(user),
    channel: "web",
    ...requestMeta(request),
  };
}

/** A request made with a person's API key; the label is the key's prefix. */
export function apiKeyActor(
  user: Person,
  apiKey: { id: string; prefix: string },
  request?: Request,
): AuditActor {
  return {
    actorType: "api_key",
    actorUserId: user.id,
    actorLabel: `API key ${apiKey.prefix}`,
    channel: "api",
    apiKeyId: apiKey.id,
    ...requestMeta(request),
  };
}

/** The actor of an authenticated `/api/*` request. */
export function httpActor(
  auth: {
    user: Person;
    authMethod: "session" | "apiKey";
    apiKey?: { id: string; prefix: string };
    impersonatedBy?: Person | null;
  },
  request?: Request,
): AuditActor {
  return auth.authMethod === "apiKey" && auth.apiKey
    ? apiKeyActor(auth.user, auth.apiKey, request)
    : userActor(auth.user, request, auth.impersonatedBy);
}

/** An MCP client acting for a person with an OAuth token. */
export function mcpActor(
  user: Person,
  client: { id: string; name?: string | null },
  request?: Request,
): AuditActor {
  return {
    actorType: "mcp",
    actorUserId: user.id,
    actorLabel: `MCP client ${client.name || client.id}`,
    channel: "mcp",
    mcpClientId: client.id,
    ...requestMeta(request),
  };
}

/** A JMAP client: a mail app using a person's API key, or their session. */
export function jmapActor(
  auth: {
    user: Person;
    authMethod: "session" | "apiKey";
    apiKey?: { id: string; prefix: string };
    impersonatedBy?: Person | null;
  },
  request?: Request,
): AuditActor {
  const by = auth.impersonatedBy;
  return {
    actorType: "jmap",
    actorUserId: by ? by.id : auth.user.id,
    actorLabel: by
      ? `JMAP (session, ${personLabel(by)} as ${personLabel(auth.user)})`
      : `JMAP (${auth.apiKey?.prefix ?? "session"})`,
    channel: "jmap",
    ...(auth.apiKey ? { apiKeyId: auth.apiKey.id } : {}),
    ...requestMeta(request),
  };
}

/** The native agent acting in one of a person's chat sessions. */
export function agentActor(
  user: Person,
  sessionId?: string | null,
): AuditActor {
  return {
    actorType: "agent",
    actorUserId: user.id,
    actorLabel: `agent for ${personLabel(user)}`,
    channel: "agent",
    ...(sessionId ? { agentSessionId: sessionId } : {}),
  };
}

/** An automation rule acting on a message it matched. */
export function ruleActor(rule: { id: string; name: string }): AuditActor {
  return {
    actorType: "rule",
    actorUserId: null,
    actorLabel: `rule ${rule.name}`,
    channel: "rule",
    ruleId: rule.id,
  };
}
