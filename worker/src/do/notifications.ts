import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "../db/schema";
import { pushSubscriptions } from "../db/push-subscriptions.schema";
import { expoPushSubscriptions } from "../db/expo-push-subscriptions.schema";
import { sendPush, type PushPayload, type VapidConfig } from "../lib/web-push";
import { buildMessage, sendExpoPush } from "../lib/expo-push";

interface DeliverPayload {
  inbox: string;
  threadId: string;
  personId: string;
  senderName: string;
  subject: string;
  bodyPreview: string;
}

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
    const payload = (await request.json()) as DeliverPayload;

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

    const db = drizzle(this.env.DB, { schema });

    // Routing identifiers only. Whether the sender and subject travel with the
    // notification is decided per transport below: the web-push payload is
    // encrypted end-to-end to the browser, whereas a native payload passes
    // through Expo and then Apple or Google in the clear, which is a different
    // exposure for a self-hosted product.
    const routing = {
      url: `/inbox/${encodeURIComponent(payload.inbox)}/${payload.personId}`,
      threadId: payload.threadId,
      personId: payload.personId,
      inbox: payload.inbox,
    };

    const [web, expo] = await Promise.all([
      this.deliverWebPush(db, userId, payload, routing),
      this.deliverExpoPush(db, userId, payload, routing),
    ]);

    console.log(
      `[push] deliver: user=${userId} web(sent=${web.sent} pruned=${web.pruned}) expo(sent=${expo.sent} pruned=${expo.pruned}) wsCount=${wsCount}`,
    );

    // `via: "push"` means push was *attempted* — i.e. the user had at least one
    // subscription on some transport — not that a send succeeded. That is the
    // pre-existing contract and callers key on it; a delivery that fails at the
    // push service is still a delivery that was tried, and reporting "ws"
    // instead would hide the attempt entirely.
    const attemptedPush = web.attempted + expo.attempted > 0;
    return Response.json({
      via: attemptedPush ? "push" : wsCount > 0 ? "ws" : "none",
      sent: web.sent + expo.sent,
      pruned: web.pruned + expo.pruned,
      wsCount,
    });
  }

  /**
   * Encrypted Web Push to browsers. Unchanged in behaviour; the VAPID guard
   * moved in here from the top of `handleDeliver` so that a deployment serving
   * only native clients works with no VAPID keys configured at all. Previously
   * an unset key skipped every transport, not just this one.
   */
  private async deliverWebPush(
    db: ReturnType<typeof drizzle>,
    userId: string,
    payload: DeliverPayload,
    routing: Record<string, unknown>,
  ): Promise<{ sent: number; pruned: number; attempted: number }> {
    const vapidPublic = this.env.VAPID_PUBLIC_KEY ?? "";
    const vapidPrivate = this.env.VAPID_PRIVATE_KEY ?? "";
    const vapidSubject = this.env.VAPID_SUBJECT ?? "";
    if (!vapidPublic || !vapidPrivate || !vapidSubject) {
      return { sent: 0, pruned: 0, attempted: 0 };
    }
    // Subject must be a real mailto:/https: URL — the example placeholder
    // "mailto:admin@<your-domain>" would silently 400 at the push service.
    if (
      !/^(mailto:|https:\/\/)/.test(vapidSubject) ||
      /[<>]/.test(vapidSubject)
    ) {
      console.warn(
        `[push] VAPID_SUBJECT looks invalid (${vapidSubject}); push services will reject. Expected mailto:you@example.com or https://example.com`,
      );
    }

    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    if (subs.length === 0) return { sent: 0, pruned: 0, attempted: 0 };

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
      data: routing,
    };

    const results = await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          const { status } = await sendPush(
            { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
            pushPayload,
            vapid,
          );
          return { id: sub.id, status };
        } catch (err) {
          console.error(
            `[push] web send threw for sub=${sub.id}: ${err instanceof Error ? err.message : String(err)}`,
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
    return { sent, pruned, attempted: subs.length };
  }

  /**
   * Native push via Expo. Needs no configuration: credentials live on the Expo
   * project that built the app, not on this deployment.
   *
   * The payload carries no sender or subject unless the deployment opts in.
   * A native notification passes through Expo and then Apple or Google before
   * reaching a lock screen, so the default is a wake-up that tells the client
   * *that* something arrived and where to look, leaving it to fetch the content
   * over an authenticated connection.
   */
  private async deliverExpoPush(
    db: ReturnType<typeof drizzle>,
    userId: string,
    payload: DeliverPayload,
    routing: Record<string, unknown>,
  ): Promise<{ sent: number; pruned: number; attempted: number }> {
    const subs = await db
      .select()
      .from(expoPushSubscriptions)
      .where(eq(expoPushSubscriptions.userId, userId));
    if (subs.length === 0) return { sent: 0, pruned: 0, attempted: 0 };

    const withPreview = this.env.PUSH_PREVIEWS === "true";

    const messages = subs.map((sub) =>
      buildMessage({
        token: sub.token,
        senderName: payload.senderName,
        subject: payload.subject,
        data: routing,
        withPreview,
      }),
    );

    const result = await sendExpoPush(messages);

    let pruned = 0;
    if (result.invalidTokens.length > 0) {
      for (const token of result.invalidTokens) {
        // Delete by token, not by installation: a row whose token has since
        // been rotated is live again and must survive a stale verdict about
        // the old one.
        const del = await db
          .delete(expoPushSubscriptions)
          .where(eq(expoPushSubscriptions.token, token));
        pruned++;
        void del;
      }
    }

    if (result.sent > 0) {
      const now = Math.floor(Date.now() / 1000);
      await db
        .update(expoPushSubscriptions)
        .set({ lastUsedAt: now })
        .where(eq(expoPushSubscriptions.userId, userId));
    }

    return { sent: result.sent, pruned, attempted: subs.length };
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}
  webSocketClose(_ws: WebSocket) {}
  webSocketError(_ws: WebSocket) {}
}
