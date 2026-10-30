import { AsyncLocalStorage } from "node:async_hooks";

export type AuditActorType =
  | "user"
  | "api_key"
  | "mcp"
  | "jmap"
  | "agent"
  | "rule"
  | "system";

export type AuditChannel =
  | "web"
  | "api"
  | "mcp"
  | "jmap"
  | "agent"
  | "rule"
  | "inbound"
  | "cron"
  | "queue"
  | "import";

/**
 * Who is acting, for the audit log. Set once at each boundary (an HTTP
 * request, an MCP or JMAP call, an agent turn, the inbound handler, the queue,
 * cron, a rule) and read by `recordAudit`; services never take it as a
 * parameter.
 */
export interface AuditActor {
  actorType: AuditActorType;
  /** The person behind the actor, also for an API key, MCP, JMAP or the agent. */
  actorUserId: string | null;
  /** What the log shows: an email, "API key sk_1234…", a rule's name, "system". */
  actorLabel: string;
  channel: AuditChannel;
  ip?: string | null;
  userAgent?: string | null;
  apiKeyId?: string;
  mcpClientId?: string;
  agentSessionId?: string;
  ruleId?: string;
}

const storage = new AsyncLocalStorage<AuditActor>();

/** The actor for work nobody is behind: cron, the queue, inbound mail. */
export function systemActor(channel: AuditChannel): AuditActor {
  return {
    actorType: "system",
    actorUserId: null,
    actorLabel: "system",
    channel,
  };
}

/** Runs `fn` with `actor` as the audit actor of everything it awaits. */
export function runWithAudit<T>(actor: AuditActor, fn: () => T): T {
  return storage.run(actor, fn);
}

/**
 * The actor set by the nearest enclosing `runWithAudit`. Work no boundary
 * claimed is the system's.
 */
export function currentAuditActor(): AuditActor {
  return storage.getStore() ?? systemActor("cron");
}
