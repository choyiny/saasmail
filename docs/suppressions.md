[saasmail](../README.md) › [Docs](README.md) › **Suppressions and unsubscribe**

# Suppressions and unsubscribe

saasmail tracks unsubscribed and manually-suppressed recipients in a `suppressions` table. Suppression checks run on every outbound dispatch path: `POST /api/send`, scheduled sequence steps, and admin template test-sends. Admins manage the list at `/admin/suppressions` (CRUD also exposed at `/api/suppressions`).

- **List-Unsubscribe headers**: marketing sends automatically include `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) headers so Gmail/Yahoo bulk-sender rules and major mail clients render native unsubscribe affordances.
- **Unsubscribe footer**: templates can use `{{unsubscribe_url}}` in HTML or plaintext bodies. If the rendered output doesn't include the URL, saasmail auto-appends a minimal unsubscribe footer.
- **Unsubscribe page**: recipients land on `/unsubscribe?token=…`. The page POSTs to `/api/unsubscribe` on JavaScript mount (so URL-preview crawlers don't trigger it) and offers a "Re-subscribe" button. One-click unsubscribe (RFC 8058) also works via `POST /api/unsubscribe?token=…` directly — no session, no UI; the token signs the recipient's email.
- **Transactional sends**: account-critical and ordinary 1:1 mail sent through `POST /api/send` or MCP `send_email` should pass `transactional: true`. The flag bypasses the suppression list and skips both the `List-Unsubscribe` headers and unsubscribe footer. Because it also bypasses suppression, use it only when the message is genuinely transactional or person-to-person rather than marketing mail.

> **Behavior shift for API integrators**: `POST /api/send` and MCP `send_email` add `List-Unsubscribe` metadata to non-transactional sends. If an integration is sending a normal 1:1 conversation, password reset, OTP, receipt, or other non-marketing message, set `transactional: true` explicitly. saasmail's inbound automation guards treat `List-Unsubscribe` as a bulk/automated signal, so leaving the flag false on 1:1 mail also suppresses suggested replies and rule auto-replies at another saasmail instance.

The Worker signs unsubscribe tokens with `UNSUBSCRIBE_SECRET` (see [Configuration](configuration.md#devvars)) and builds absolute URLs from the existing `BASE_URL` setting.

---

**See also:** [Email templates](templates.md) · [Sequences](sequences.md) · [Configuration](configuration.md)
