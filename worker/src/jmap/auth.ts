import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  resolveAllowedInboxes,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import { resolveRequestAuth } from "../lib/request-auth";
import { passkeyRequired } from "../middleware/require-passkey";

export type JmapAccess = {
  user: any;
  allowed: AllowedInboxes;
  authMethod: "session" | "apiKey";
};

export function problem(
  status: number,
  type: string,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type,
      title,
      status,
      ...(detail ? { detail } : {}),
      ...extra,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function authenticateJmap(
  request: Request,
  env: CloudflareBindings,
  db: DrizzleD1Database<any>,
): Promise<JmapAccess | Response> {
  const resolved = await resolveRequestAuth(request, env, db);
  if (!resolved) {
    return problem(
      401,
      "about:blank",
      "Unauthorized",
      "Authentication is required for JMAP.",
    );
  }

  if (await passkeyRequired(env, db, resolved.user, resolved.authMethod)) {
    return problem(
      403,
      "about:blank",
      "Forbidden",
      "Passkey registration is required.",
      { code: "PASSKEY_REQUIRED" },
    );
  }

  return {
    user: resolved.user,
    allowed: await resolveAllowedInboxes(db, resolved.user),
    authMethod: resolved.authMethod,
  };
}
