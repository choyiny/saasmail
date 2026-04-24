import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "../db/schema";
import { pushSubscriptions } from "../db/push-subscriptions.schema";
import { sendPush, type PushPayload, type VapidConfig } from "../lib/web-push";

export class NotificationsHub implements DurableObject {
  ctx: DurableObjectState;
  env: CloudflareBindings;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/deliver" && request.method === "POST") {
      return this.handleDeliver(request);
    }

    // Back-compat: /notify falls through to WS-only delivery. Remove once the
    // email-handler is fully migrated (Task 9) and no callers remain.
    if (url.pathname === "/notify" && request.method === "POST") {
      const { inbox } = (await request.json()) as { inbox: string };
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify({ type: "email_received", inbox }));
        } catch {}
      }
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleDeliver(request: Request): Promise<Response> {
    const payload = (await request.json()) as {
      inbox: string;
      threadId: string;
      personId: string;
      senderName: string;
      subject: string;
      bodyPreview: string;
    };

    // Fan out to any live WebSocket clients (best-effort, non-blocking for push).
    const sockets = this.ctx.getWebSockets();
    const wsCount = sockets.length;
    if (wsCount > 0) {
      // Back-compat frame shape — useRealtimeUpdates already handles this.
      const frame = JSON.stringify({
        type: "email_received",
        inbox: payload.inbox,
      });
      for (const ws of sockets) {
        try {
          ws.send(frame);
        } catch {}
      }
    }

    // Always attempt Web Push as well — a connected WS tab may be backgrounded,
    // the user may have other devices, or the socket may be a stale hibernated one.
    const userId = this.ctx.id.name; // DO id is idFromName(userId)
    if (!userId) {
      console.warn("[push] deliver: missing DO name (userId); skipping push");
      return Response.json({ via: wsCount > 0 ? "ws" : "none", wsCount });
    }

    const vapidPublic = this.env.VAPID_PUBLIC_KEY ?? "";
    const vapidPrivate = this.env.VAPID_PRIVATE_KEY ?? "";
    const vapidSubject = this.env.VAPID_SUBJECT ?? "";
    if (!vapidPublic || !vapidPrivate || !vapidSubject) {
      console.warn(
        `[push] deliver: VAPID not configured (publicKey=${vapidPublic ? "set" : "empty"}, privateKey=${vapidPrivate ? "set" : "empty"}, subject=${vapidSubject ? "set" : "empty"}); skipping push for user=${userId}`,
      );
      return Response.json({ via: wsCount > 0 ? "ws" : "none", wsCount });
    }
    // Subject must be a real mailto:/https: URL — the example placeholder
    // "mailto:admin@<your-domain>" would silently 400 at the push service.
    if (
      !/^(mailto:|https:\/\/)/.test(vapidSubject) ||
      /[<>]/.test(vapidSubject)
    ) {
      console.warn(
        `[push] deliver: VAPID_SUBJECT looks invalid (${vapidSubject}); push services will reject. Expected mailto:you@example.com or https://example.com`,
      );
    }

    const db = drizzle(this.env.DB, { schema });
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));

    if (subs.length === 0) {
      console.log(
        `[push] deliver: no subscriptions for user=${userId} (wsCount=${wsCount})`,
      );
      return Response.json({ via: wsCount > 0 ? "ws" : "none", wsCount });
    }
    console.log(
      `[push] deliver: user=${userId} subs=${subs.length} wsCount=${wsCount} inbox=${payload.inbox}`,
    );

    const vapid: VapidConfig = {
      publicKey: vapidPublic,
      privateKey: vapidPrivate,
      subject: vapidSubject,
    };
    const pushPayload: PushPayload = {
      title: payload.senderName || "New email",
      body: payload.subject || payload.bodyPreview || "",
      tag: `thread:${payload.threadId}`,
      icon: "/saasmail-logo.png",
      badge: "/saasmail-logo.png",
      data: {
        url: `/inbox/${encodeURIComponent(payload.inbox)}/${payload.personId}`,
        threadId: payload.threadId,
      },
    };

    const results = await Promise.allSettled(
      subs.map(async (sub) => {
        const host = (() => {
          try {
            return new URL(sub.endpoint).host;
          } catch {
            return "invalid-endpoint";
          }
        })();
        try {
          const { status } = await sendPush(
            { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
            pushPayload,
            vapid,
          );
          if (status >= 400) {
            console.warn(
              `[push] send: non-2xx status=${status} host=${host} sub=${sub.id}`,
            );
          } else {
            console.log(
              `[push] send: ok status=${status} host=${host} sub=${sub.id}`,
            );
          }
          return { id: sub.id, status };
        } catch (err) {
          console.error(
            `[push] send: threw host=${host} sub=${sub.id}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
          );
          return { id: sub.id, status: 0 };
        }
      }),
    );

    const now = Math.floor(Date.now() / 1000);
    let sent = 0;
    let pruned = 0;
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { id, status } = r.value;
      if (status >= 200 && status < 300) {
        sent++;
        await db
          .update(pushSubscriptions)
          .set({ lastUsedAt: now })
          .where(eq(pushSubscriptions.id, id));
      } else if (status === 404 || status === 410) {
        pruned++;
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
      }
      // 401/403/0/other: leave the row, log-only.
    }

    console.log(
      `[push] deliver: user=${userId} sent=${sent} pruned=${pruned} total=${subs.length} wsCount=${wsCount}`,
    );
    return Response.json({ via: "push", sent, pruned, wsCount });
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}
  webSocketClose(_ws: WebSocket) {}
  webSocketError(_ws: WebSocket) {}
}
