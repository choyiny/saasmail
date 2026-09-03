[saasmail](../README.md) › [Docs](README.md) › **Suppressions and unsubscribe**

# Suppressions and unsubscribe

saasmail tracks unsubscribed and manually-suppressed recipients in a `suppressions` table. Suppression checks run on every outbound dispatch path: `POST /api/send`, scheduled sequence steps, and admin template test-sends. Admins manage the list at `/admin/suppressions` (CRUD also exposed at `/api/suppressions`).

- **List-Unsubscribe headers**: marketing sends automatically include `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) headers so Gmail/Yahoo bulk-sender rules and major mail clients render native unsubscribe affordances.
- **Unsubscribe footer**: templates can use `{{unsubscribe_url}}` in HTML or plaintext bodies. If the rendered output doesn't include the URL, saasmail auto-appends a minimal unsubscribe footer.
- **Unsubscribe page**: recipients land on `/unsubscribe?token=…`. The page POSTs to `/api/unsubscribe` on JavaScript mount (so URL-preview crawlers don't trigger it) and offers a "Re-subscribe" button. One-click unsubscribe (RFC 8058) also works via `POST /api/unsubscribe?token=…` directly — no session, no UI; the token signs the recipient's email.
- **Transactional sends**: account-critical mail (password resets, OTPs, system notifications) should pass `transactional: true` in the `POST /api/send` body. This bypasses the suppression check, skips the unsubscribe headers, and skips the footer auto-append. Anyone you genuinely _need_ to email will still get the message.

> **Behavior shift for API integrators**: `POST /api/send` now adds `List-Unsubscribe` headers and (if the body lacks the URL) appends an unsubscribe footer to every send UNLESS the caller passes `transactional: true`. If your integration sends password resets, OTPs, or other account-critical mail through `/api/send`, set the flag explicitly on those calls to preserve the previous behavior.

The Worker signs unsubscribe tokens with `UNSUBSCRIBE_SECRET` (see [Configuration](configuration.md#devvars)) and builds absolute URLs from the existing `BASE_URL` setting.

---

**See also:** [Email templates](templates.md) · [Sequences](sequences.md) · [Configuration](configuration.md)
