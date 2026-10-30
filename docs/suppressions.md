[saasmail](../README.md) › [Docs](README.md) › **Suppressions and unsubscribe**

# Suppressions and unsubscribe

saasmail tracks unsubscribed, manually-suppressed and [bounced](#bounces-and-complaints) recipients in a `suppressions` table. Suppression checks run on every outbound dispatch path: `POST /api/send`, scheduled sequence steps, and admin template test-sends. Admins manage the list at `/admin/suppressions` (CRUD also exposed at `/api/suppressions`).

- **List-Unsubscribe headers**: marketing sends automatically include `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) headers so Gmail/Yahoo bulk-sender rules and major mail clients render native unsubscribe affordances.
- **Unsubscribe footer**: templates can use `{{unsubscribe_url}}` in HTML or plaintext bodies. If the rendered output doesn't include the URL, saasmail auto-appends a minimal unsubscribe footer.
- **Unsubscribe page**: recipients land on `/unsubscribe?token=…`. The page POSTs to `/api/unsubscribe` on JavaScript mount (so URL-preview crawlers don't trigger it) and offers a "Re-subscribe" button. One-click unsubscribe (RFC 8058) also works via `POST /api/unsubscribe?token=…` directly — no session, no UI; the token signs the recipient's email.
- **Transactional sends**: account-critical and ordinary 1:1 mail sent through `POST /api/send` or MCP `send_email` should pass `transactional: true`. The flag bypasses the suppression list and skips both the `List-Unsubscribe` headers and unsubscribe footer. Because it also bypasses suppression, use it only when the message is genuinely transactional or person-to-person rather than marketing mail.

> **Behavior shift for API integrators**: `POST /api/send` and MCP `send_email` add `List-Unsubscribe` metadata to non-transactional sends. If an integration is sending a normal 1:1 conversation, password reset, OTP, receipt, or other non-marketing message, set `transactional: true` explicitly. saasmail's inbound automation guards treat `List-Unsubscribe` as a bulk/automated signal, so leaving the flag false on 1:1 mail also suppresses suggested replies and rule auto-replies at another saasmail instance.

## Bounces and complaints

With Cloudflare Email Sending, and once the instance's queue is subscribed to the sending domain's events ([Email providers](email-providers.md#bounces-and-complaints)), saasmail records what Cloudflare reports after it accepted a message: a bounce, a spam complaint, a rejection or a failure. Each event is stored once (a redelivered event changes nothing), attached to the sent message it is about, and shown on it: "Bounced", "Marked as spam", "Rejected" or "Not delivered", with the recipient, the SMTP status and the provider's text in the tooltip ("Bounced for 1 of 3" when the message had several recipients). A campaign's **Bounces** and **Complaints** tiles count its events.

What each event does:

| Event                                                  | Suppression reason                                                                                                                                     | Newsletter lists                                   | Transactional mail |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------ |
| Hard bounce (the address does not exist)               | `hard_bounce`, replacing any other reason the address had                                                                                              | unsubscribed from every list, reason `hard_bounce` | **refused**        |
| Soft bounce (Cloudflare gave up retrying)              | `soft_bounce` at the third soft bounce within any 30 days, by when they occurred (hard bounces do not count), unless the address is already suppressed | unchanged                                          | sent               |
| Spam complaint                                         | `complaint`, unless the address is already suppressed                                                                                                  | unsubscribed from every list, reason `complaint`   | sent by saasmail   |
| Rejected because Cloudflare's own list has the address | `provider`, unless the address is already suppressed                                                                                                   | unchanged                                          | sent by saasmail   |
| Any other rejection, or a failure                      | none                                                                                                                                                   | unchanged                                          | sent               |

Every suppression stops marketing mail: template sends, sequences and campaigns. Only a hard bounce also stops transactional mail, because the address cannot receive anything: a transactional compose (`POST /api/send` with `transactional: true`) or a reply to it (`POST /api/send/reply/{emailId}`, MCP `reply_email`, also from an inbox connected to Gmail or Outlook) is refused with `422` and code `RECIPIENT_HARD_BOUNCED`, naming the `addresses`, and nothing is sent or stored. A non-transactional compose (also MCP `send_email`) goes to the other recipients and lists the address under `suppressed`, as for any suppression. The answer is not kept for the idempotency key, so a retry with the same key sends once the address is removed. A JMAP `EmailSubmission/set` answers `invalidRecipients`; a delayed JMAP send whose recipient hard-bounced while it waited fails instead of going out; an outbox retry with a hard-bounced recipient anywhere in its envelope stops, as for a suppressed one.

A bounce on a copy of a non-transactional send (each recipient gets their own copy) is attached to the message too: saasmail keeps every copy's provider Message-ID.

An unsubscribe link never reverses a provider's decision: its Re-subscribe button removes only the `unsubscribe` suppression the link made (it answers `410` while another reason keeps the address suppressed, also `manual`), and a campaign link does not put back a list membership a hard bounce or complaint removed.

Remove an address on the Suppressions page when it works again. **Cloudflare keeps its own suppression list** for hard bounces and complaints, and removing the address in saasmail does not remove it there: Cloudflare still refuses mail to it until you remove it in the Cloudflare dashboard too. The page says so on those rows.

The audit log records `mail.bounced`, `mail.complained`, `mail.rejected` and `mail.failed`, naming the message, never the address. A contact export includes the address's delivery events, and erasing the contact replaces their address with the erasure pseudonym and clears the SMTP text. Other providers (Resend, Postmark, Bavimail) report nothing to saasmail yet.

The Worker signs unsubscribe tokens with `UNSUBSCRIBE_SECRET` (see [Configuration](configuration.md#devvars)) and builds absolute URLs from the existing `BASE_URL` setting.

---

**See also:** [Email templates](templates.md) · [Sequences](sequences.md) · [Configuration](configuration.md)
