[saasmail](../README.md) › [Docs](README.md) › **Webhooks**

# Webhooks

POST to an external URL whenever a **new inbound message** is received — useful for help-desk automation (post to a team chat, trigger triage, draft a reply via n8n / Make / etc.).

- **Config:** Admins set a destination URL (and optional signing secret) on the **API keys** page. Global, single best-effort attempt, **disabled by default** (no URL = nothing fires). Any URL scheme is accepted, including `http://` for local automation.
- **Event:** one `message.received` per received message (deduped by `Message-ID`).
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
