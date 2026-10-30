[saasmail](../README.md) › [Docs](README.md) › **Webhooks**

# Webhooks

POST to an external URL whenever a **new inbound message** is received — useful for help-desk automation (post to a team chat, trigger triage, draft a reply via n8n / Make / etc.). The same endpoint can also receive **delivery events** about mail sent from saasmail: accepted, bounced, complained or failed (see [Delivery events](#delivery-events)).

- **Config:** Admins set a destination URL (and optional signing secret) on the **API keys** page. Global, single best-effort attempt (outbound events retry), **disabled by default** (no URL = nothing fires). Any URL scheme is accepted, including `http://` for local automation.
- **Event:** one `message.received` per received message per inbox (deduped by `Message-ID` within an inbox: a message addressed to two of your inboxes produces one event for each).
- **Events list:** one checkbox per event under the URL. `message.received` is ticked by default, and a config saved before the list existed sends `message.received` only. Untick it to stop it. Outbound events retry (see [Delivery events](#delivery-events)).
- **Security:** when a secret is set, each request includes `X-SaaSMail-Signature: sha256=<hmac>`, an HMAC-SHA256 of the raw request body. Verify it before trusting the payload.

## Payload

```json
{
  "event": "message.received",
  "id": "abc123",
  "receivedAt": 1717459200,
  "inbox": "support@yourdomain.com",
  "from": { "address": "customer@example.com", "name": "Jane Customer" },
  "subject": "Help with my order",
  "textPreview": "Hi, I can't log in…",
  "conversationId": "…",
  "attachments": [
    { "filename": "screenshot.png", "contentType": "image/png", "size": 20481 }
  ],
  "auth": { "spf": "pass", "dkim": "pass", "dmarc": "pass" },
  "url": "https://mail.yourdomain.com/m/abc123"
}
```

## Delivery events

Opt-in events about messages sent from saasmail (compose, replies, the API, MCP, JMAP, campaigns and sequences):

| Event                | When                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.sent`       | The provider accepted the message (first try or a later outbox retry). One per sent message, also for each campaign and sequence send.                                                                                                  |
| `message.bounced`    | The provider reported a bounce ([Bounces and complaints](suppressions.md#bounces-and-complaints)).                                                                                                                                      |
| `message.complained` | A recipient marked it as spam.                                                                                                                                                                                                          |
| `message.failed`     | The send failed for good: a permanent provider error, the outbox's retries spent, a retry stopped because a recipient is now suppressed (reason `suppressed`), or the provider's own `failed` or `rejected` report (`delivery.status`). |

There is no `message.delivered`, `message.deferred` or `message.suppressed`. A send the suppression list stops before the provider is not a sent message and raises nothing. A provider event that matches no sent message (for example about a recipient of an old message whose row is gone) raises no webhook, because the payload needs a `message.id`.

A campaign of N recipients produces N `message.sent` events, plus one provider event per recipient that bounces or complains. A manual retry can revive a failed message, so a receiver can see `message.failed` and later `message.sent` for the same `message.id`.

**Gmail and Outlook replies.** A reply from an inbox mapped to Gmail or Outlook goes out through that mailbox, not the outbox. It raises `message.sent` once it is stored. A failed one is not stored and answers the caller `502 SEND_FAILED` at once, so it raises no `message.failed`.

### Payload

Every delivery event has the same shape. It carries addresses and the subject, never any body text. `message.sent` has no `delivery` object.

```json
{
  "event": "message.bounced",
  "deliveryId": "wd_…",
  "occurredAt": 1717459200,
  "message": {
    "id": "<sent message id>",
    "messageId": "<abc@yourdomain.com>",
    "from": "support@yourdomain.com",
    "recipients": ["customer@example.com"],
    "subject": "Your invoice",
    "campaignId": null,
    "sequenceId": null,
    "sequenceEnrollmentId": null,
    "conversationId": "…",
    "url": "https://mail.yourdomain.com/m/<sent message id>"
  },
  "delivery": {
    "recipient": "customer@example.com",
    "status": "bounced",
    "bounceType": "hard",
    "smtpStatus": "550",
    "enhancedStatus": "5.1.1",
    "reason": "550 5.1.1 User unknown",
    "provider": "cloudflare"
  }
}
```

- `message.id` is the `id` that `POST /api/send`, `POST /api/send/reply/{id}` and the MCP send tools return: store it with the send and join on it.
- `message.recipients` lists the To and Cc recipients that were sent to, never a Bcc.
- `delivery.recipient` is null when the whole message failed, and when the provider reports about a Bcc recipient, which also nulls `delivery.reason` (a bounce text usually quotes the address, and a Bcc stays blind). `delivery.reason` is at most 200 characters.
- `occurredAt` is when it happened (unix seconds): reject a request whose `occurredAt` is older than you accept, to refuse old replays.

### Headers, retries and dedupe

Delivery events carry the same `X-SaaSMail-Signature` and `X-SaaSMail-Event` headers as `message.received`, plus `X-SaaSMail-Delivery: <deliveryId>`. That id is the same on every retry of one event: store it and ignore a request whose id you have already handled.

`message.received` keeps its single best-effort attempt. Delivery events are retried and delivered **at least once**: up to 4 attempts, 1, 5 and 30 minutes apart, on a network error, a timeout, `408`, `429` or a `5xx`. Any other `4xx` fails at once. Every attempt sends exactly the same body. Saving the config (a new URL or secret) cancels the deliveries still pending from before it.

**Pause after 20 failures.** When 20 deliveries in a row fail (retries spent, or refused with a `4xx`), the delivery events pause: none are recorded until an admin re-enables them (a delivered event starts the count again, except one that finishes after the pause; saving or re-enabling starts it at 0), and the audit log records `webhook.auto_disabled`. The API keys page shows "Delivery events paused after 20 failed deliveries" with the last result and a **Re-enable** button (`POST /api/webhook/enable`, audited as `webhook.enabled`). Saving the config re-enables it too. `message.received` keeps being sent while paused and never counts.

### Recent deliveries

The API keys page lists the last 20 delivery events (`GET /api/webhook/deliveries?limit=20`): the event, the time, the status (`pending`, `delivered`, `failed`, `cancelled`), the last HTTP status or error and the attempts. It shows no address and no subject; the body is kept only while a delivery is pending. Rows are deleted 7 days after they finish. `message.received` is not listed.

**Send test** sends a synthetic payload of the chosen event once, directly: no retry and no list row (`POST /api/webhook/test` with `{ "event": "message.sent" }`; no body sends `message.received`).

## Verifying the signature

Node example:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret) {
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

---

**See also:** [Users and API keys](users-and-api-keys.md) · [Inboxes and timelines](inboxes.md) · [Per-inbox forwarding](inboxes.md#per-inbox-forwarding) if you want a copy of the mail itself rather than a callback
