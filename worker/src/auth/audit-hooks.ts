import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users } from "../db/auth.schema";
import { anonymousHttpActor, userActor } from "../lib/audit/actors";
import { runWithAudit } from "../lib/audit/context";
import { AUDIT_ACTIONS } from "../lib/audit/events";
import { recordAudit } from "../lib/audit/record";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/**
 * What an after-hook sees of a finished better-auth request. Kept loose on
 * purpose: only the few fields read here, all optional, so a library upgrade
 * that moves one degrades to "not recorded" rather than a failed sign-in.
 */
export interface AuthHookContext {
  path?: string;
  body?: Record<string, unknown> | null;
  query?: Record<string, unknown> | null;
  request?: Request;
  context?: {
    returned?: unknown;
    /** The session a sign-in (or an impersonation) just created. */
    newSession?: { user?: AuthUser | null } | null;
    /** The caller's own session, on endpoints that require one. */
    session?: { user?: AuthUser | null } | null;
  };
}

type AuthUser = { id: string; email?: string | null; name?: string | null };

const SIGN_IN_METHOD: Record<string, string> = {
  "/sign-in/email": "password",
  "/passkey/verify-authentication": "passkey",
};

/**
 * Account changes an admin can make through better-auth's own admin API,
 * which no route of ours sees. None of their request fields is recorded: a
 * new password is among them.
 */
const ADMIN_ACCOUNT_CHANGES: Record<string, string> = {
  "/admin/ban-user": "banned",
  "/admin/unban-user": "unbanned",
  "/admin/set-user-password": "password set",
  "/admin/revoke-user-session": "a session revoked",
  "/admin/revoke-user-sessions": "all sessions revoked",
  "/admin/update-user": "profile updated",
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function failed(returned: unknown): boolean {
  if (isAPIError(returned) || returned instanceof Error) return true;
  return returned instanceof Response && returned.status >= 400;
}

/** A plausible address, at most as long as an address can be. */
function emailOf(value: unknown): string | null {
  const candidate = text(value)?.trim().toLowerCase();
  if (!candidate || candidate.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

async function userEmail(
  db: Db,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

/** A failed sign-in is recorded at most once a minute per account or address. */
const FAILED_SIGN_IN_WINDOW_SECONDS = 60;

/**
 * Records a failed sign-in, sparingly. These requests need no authentication,
 * so what they can write is limited: only against an account that exists (a
 * mistyped password in the address field is never stored), and at most one
 * row a minute per account, or per caller address when no account is named.
 */
export async function recordFailedSignIn(
  db: Db,
  attempt: {
    method: string;
    user?: { id: string; email: string } | null;
    request?: Request;
    reason?: string;
  },
): Promise<void> {
  const ip = attempt.request?.headers.get("cf-connecting-ip") ?? null;
  const same = attempt.user
    ? sql`target_id = ${attempt.user.id}`
    : ip
      ? sql`target_id IS NULL AND ip = ${ip}`
      : sql`target_id IS NULL AND ip IS NULL`;
  const since = Math.floor(Date.now() / 1000) - FAILED_SIGN_IN_WINDOW_SECONDS;
  const recent = await db.all(sql`
    SELECT 1 AS one FROM audit_events
    WHERE action = ${AUDIT_ACTIONS.authSignInFailed} AND at >= ${since}
      AND ${same}
    LIMIT 1
  `);
  if (recent.length > 0) return;

  // Nobody is signed in. The row carries the address of the request that
  // failed, which is also what the once-a-minute check above looks for.
  const write = () =>
    recordAudit(db, {
      action: AUDIT_ACTIONS.authSignInFailed,
      targetType: "user",
      targetId: attempt.user?.id ?? null,
      summary: attempt.user
        ? attempt.reason === "passkey_required"
          ? `Refused password sign-in for ${attempt.user.email}: the account has a passkey`
          : `Failed ${attempt.method} sign-in for ${attempt.user.email}`
        : `Failed ${attempt.method} sign-in`,
      details: {
        method: attempt.method,
        ...(attempt.user ? { email: attempt.user.email } : {}),
        ...(attempt.reason ? { reason: attempt.reason } : {}),
      },
    });
  await (attempt.request
    ? runWithAudit(anonymousHttpActor(attempt.request), write)
    : write());
}

/**
 * Records sign-ins, passkey changes, OAuth client and consent changes, and
 * what an admin does through better-auth's admin API. These requests go to
 * better-auth directly and pass no route of ours, so this hook is the only
 * place they can be seen.
 */
export async function auditAuthRequest(
  db: Db,
  ctx: AuthHookContext,
): Promise<void> {
  const path = ctx.path;
  if (!path) return;
  const returned = ctx.context?.returned;
  const ok = !failed(returned);
  // Who made the request. An impersonation also creates a session, for the
  // user being impersonated: that is never the caller.
  const caller = ctx.context?.session?.user ?? null;
  const asUser = <T>(user: AuthUser, fn: () => Promise<T>) =>
    runWithAudit(userActor(user, ctx.request), fn);

  const method = SIGN_IN_METHOD[path];
  if (method) {
    const user = ctx.context?.newSession?.user;
    if (ok && user) {
      await asUser(user, () =>
        recordAudit(db, {
          action: AUDIT_ACTIONS.authSignIn,
          targetType: "user",
          targetId: user.id,
          summary: `Signed in with a ${method}`,
          details: { method },
        }),
      );
    } else if (!ok) {
      if (method !== "password") {
        await recordFailedSignIn(db, { method, request: ctx.request });
        return;
      }
      const email = emailOf(ctx.body?.email);
      if (!email) return;
      const [account] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (!account) return;
      await recordFailedSignIn(db, {
        method,
        user: account,
        request: ctx.request,
      });
    }
    return;
  }

  if (!ok) return;

  if (path.startsWith("/admin/")) {
    if (!caller) return; // Our own server-side calls (invite accept, setup).
    const targetId = text(ctx.body?.userId);
    const target = (await userEmail(db, targetId)) ?? targetId ?? "a user";
    if (path === "/admin/impersonate-user") {
      await asUser(caller, () =>
        recordAudit(db, {
          action: AUDIT_ACTIONS.userImpersonated,
          targetType: "user",
          targetId,
          summary: `Started acting as ${target}`,
        }),
      );
    } else if (path === "/admin/set-role") {
      const role = text(ctx.body?.role) ?? "another role";
      await asUser(caller, () =>
        recordAudit(db, {
          action: AUDIT_ACTIONS.userRoleChanged,
          targetType: "user",
          targetId,
          summary: `Changed ${target} to ${role}`,
          details: { to: role },
        }),
      );
    } else if (path === "/admin/remove-user") {
      await asUser(caller, () =>
        recordAudit(db, {
          action: AUDIT_ACTIONS.userRemoved,
          targetType: "user",
          targetId,
          summary: `Removed ${target}`,
        }),
      );
    } else if (path === "/admin/create-user") {
      const created = (returned as { user?: AuthUser } | null)?.user;
      const email = created?.email ?? emailOf(ctx.body?.email) ?? "a user";
      await asUser(caller, () =>
        recordAudit(db, {
          action: AUDIT_ACTIONS.userJoined,
          targetType: "user",
          targetId: created?.id ?? null,
          summary: `Created the account ${email}`,
          details: { role: text(ctx.body?.role) },
        }),
      );
    } else if (ADMIN_ACCOUNT_CHANGES[path]) {
      const change = ADMIN_ACCOUNT_CHANGES[path];
      await asUser(caller, () =>
        recordAudit(db, {
          action: AUDIT_ACTIONS.userUpdated,
          targetType: "user",
          targetId,
          summary: `Changed the account ${target}: ${change}`,
          details: { change },
        }),
      );
    }
    return;
  }

  if (path === "/passkey/verify-registration" && caller) {
    await asUser(caller, () =>
      recordAudit(db, {
        action: AUDIT_ACTIONS.userPasskeyAdded,
        targetType: "user",
        targetId: caller.id,
        summary: "Registered a passkey",
      }),
    );
  } else if (path === "/passkey/delete-passkey" && caller) {
    await asUser(caller, () =>
      recordAudit(db, {
        action: AUDIT_ACTIONS.userPasskeyRemoved,
        targetType: "user",
        targetId: caller.id,
        summary: "Removed a passkey",
        details: { passkeyId: text(ctx.body?.id) },
      }),
    );
  } else if (path === "/oauth2/register") {
    const client = (returned ?? {}) as Record<string, unknown>;
    const clientId = text(client.client_id);
    const name =
      text(client.client_name) ?? text(ctx.body?.client_name) ?? clientId;
    await recordAudit(db, {
      action: AUDIT_ACTIONS.oauthClientRegistered,
      targetType: "oauth_client",
      targetId: clientId,
      summary: `An OAuth client registered itself: ${name ?? "unnamed"}`,
      details: { clientId, name },
    });
  } else if (path === "/oauth2/consent" && caller) {
    if (ctx.body?.accept !== true) return;
    // The client is named in the authorization request the consent answers.
    const clientId = text(
      new URLSearchParams(text(ctx.body?.oauth_query) ?? "").get("client_id"),
    );
    await asUser(caller, () =>
      recordAudit(db, {
        action: AUDIT_ACTIONS.oauthConsentGranted,
        targetType: "oauth_client",
        targetId: clientId,
        summary: clientId
          ? `Granted the OAuth client ${clientId} access to their account`
          : "Granted an OAuth client access to their account",
        details: { scope: text(ctx.body?.scope) },
      }),
    );
  } else if (path === "/oauth2/delete-consent" && caller) {
    await asUser(caller, () =>
      recordAudit(db, {
        action: AUDIT_ACTIONS.oauthConsentRevoked,
        targetType: "oauth_client",
        targetId: text(ctx.body?.id),
        summary: "Withdrew an OAuth client's access to their account",
      }),
    );
  }
}

/** The `hooks.after` of the auth configuration. Never fails the request. */
export function auditAfterHook(db: Db) {
  return createAuthMiddleware(async (ctx) => {
    try {
      await auditAuthRequest(db, ctx as unknown as AuthHookContext);
    } catch (error) {
      console.warn("[audit] auth event not recorded:", error);
    }
  });
}
