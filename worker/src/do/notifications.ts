export class NotificationsHub implements DurableObject {
  ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
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

    if (url.pathname === "/notify" && request.method === "POST") {
      const { inbox } = (await request.json()) as { inbox: string };
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify({ type: "email_received", inbox }));
        } catch {
          // client disconnected; DO will clean it up via webSocketClose
        }
      }
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}
  // The socket is already closed by the time this handler runs; do not call
  // ws.close() again. The runtime will clean up the hibernated socket.
  webSocketClose(_ws: WebSocket) {}
  webSocketError(_ws: WebSocket) {}
}
