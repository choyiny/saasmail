import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { users } from "../db/auth.schema";
import { MAX_ADMIN_FANOUT, computeFanoutTargets } from "./notification-fanout";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/**
 * Tells the open tabs of everyone who can see the inbox to reload its mail,
 * the way a new suggested reply is announced. Best-effort.
 */
export async function notifyMailRefresh(
  db: Db,
  env: CloudflareBindings,
  inbox: string,
): Promise<void> {
  try {
    const [permRows, adminRows] = await Promise.all([
      db
        .select({ userId: inboxPermissions.userId })
        .from(inboxPermissions)
        .where(eq(inboxPermissions.email, inbox)),
      db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "admin"))
        .limit(MAX_ADMIN_FANOUT + 1),
    ]);
    const { userIds } = computeFanoutTargets({
      permissionUserIds: permRows.map((row) => row.userId),
      adminUserIds: adminRows.map((row) => row.id),
    });
    const payload = JSON.stringify({ type: "mail_refresh", inbox });
    await Promise.allSettled(
      userIds.map((userId) =>
        env.NOTIFICATIONS_HUB.get(
          env.NOTIFICATIONS_HUB.idFromName(userId),
        ).fetch(
          new Request("http://do/realtime", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
          }),
        ),
      ),
    );
  } catch (error) {
    console.warn("[mail-refresh] realtime refresh failed:", error);
  }
}
