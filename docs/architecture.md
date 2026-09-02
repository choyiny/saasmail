[saasmail](../README.md) › [Docs](README.md) › **Architecture**

# Architecture

```
Inbound    customer ─▶ Cloudflare Email Routing ─▶ saasmail Worker ─▶ D1 · R2 · Queue
Outbound   saasmail Worker ─▶ Email Sending / Resend / Bavimail / Postmark ─▶ customer
```

Everything runs inside a single Cloudflare Worker — no separate mail server to
operate.

## Stack

| Layer               | Technology                                                                |
| ------------------- | ------------------------------------------------------------------------- |
| **Receive email**   | Cloudflare Email Workers                                                  |
| **Send email**      | Cloudflare Email Sending, Resend, Bavimail, or Postmark                   |
| **Runtime**         | Cloudflare Workers + Hono                                                 |
| **API**             | Zod + `@hono/zod-openapi` (OpenAPI 3.0)                                   |
| **Database**        | Cloudflare D1 (SQLite)                                                    |
| **File storage**    | Cloudflare R2 (attachments)                                               |
| **Queue**           | Cloudflare Queues (sequence processing)                                   |
| **Realtime + Push** | Durable Object (`NotificationsHub`, one per user) — WebSockets + Web Push |
| **Web Push**        | VAPID + `aes128gcm` payload encryption (RFC 8291), implemented in-worker  |
| **Service Worker**  | `public/sw.js` — receives push events, renders OS notifications           |
| **Cron**            | Hourly trigger for sequence email scheduling                              |
| **Frontend**        | React + Tailwind CSS + TipTap editor                                      |
| **ORM**             | Drizzle                                                                   |
| **Auth**            | BetterAuth with passkey support                                           |

## Diagram

```mermaid
flowchart LR
    EmailRouting["Email Routing<br/>(inbound)"]
    EmailSending["Email Sending<br/>(outbound)"]

    Worker["Worker"]
    DO["NotificationsHub<br/>(Durable Object, per user)"]

    D1[("D1")]
    R2[("R2<br/>(attachments)")]
    Q[["Queue<br/>(sequence processing)"]]

    EmailRouting --> Worker
    Worker --> EmailSending
    Worker --> DO
    Worker --> D1
    Worker --> R2
    Worker <--> Q
    DO --> D1
```

The `NotificationsHub` Durable Object is keyed per user (`idFromName(userId)`). On inbound mail the worker fans out to each recipient's hub, which pushes WebSocket frames to live tabs and sends encrypted Web Push to registered devices. The queue carries scheduled sequence emails — the cron trigger enqueues due steps and a queue consumer in the same worker sends them.

---

**See also:** [Email providers](email-providers.md) · [Local development](development.md) · [AGENTS.md](../AGENTS.md) for the code-layer conventions
