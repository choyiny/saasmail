[saasmail](../README.md) › [Docs](README.md) › **Inboxes and timelines**

# Inboxes and timelines

![Unified customer timeline](screenshots/inbox-timeline.jpg)

## One timeline per customer

Every email from a given person — marketing campaigns, transactional notifications, support replies — lands on a single timeline. People are sorted by recency with unread counts, so the customer who needs attention is always on top. Click in to see the latest message, and open the thread sidebar to replay the full history. Messages render as sanitized HTML with a Slack-style reply composer.

## Multi-inbox with team permissions

Run multiple inbound addresses from a single deployment. Admins configure display names per inbox (`support@`, `sales@`, etc.) and assign members to specific inboxes. Members only see email, templates, and sequences scoped to the inboxes they're allowed to access.

## Thread or chat, per inbox

Different inboxes call for different UX. Set each inbox to render as **Thread** or **Chat**:

- **Thread** — traditional email threading with subject lines, quoted history, and formatted HTML. The right fit for `marketing@` and `newsletters@`, where context lives inside the message.
- **Chat** — bubble-style conversation view that strips away subjects and signatures so replies feel like iMessage. The right fit for `support@`, where customers expect a back-and-forth, not a formal thread.

One deployment, one person timeline, but the interaction model matches the channel.

## Per-inbox forwarding

Give any inbox a **Forward to** address and every message it receives is re-sent to
that address. Configured per inbox on the **Inboxes** page, right next to display
name, signature, mode, and member permissions. Off by default.

**Why not just use a Cloudflare Email Routing forwarding rule?** Because Email
Routing relays forwarded mail from a shared IP pool that Outlook, Hotmail, and Live
blocklist. Forwards to a Microsoft-hosted mailbox come back as:

```
permanent error (550): 5.7.1 Unfortunately, messages from [104.30.10.66] weren't
sent. Please contact your Internet service provider since part of their network is
on our block list (S3150).
```

That IP belongs to Cloudflare, not to you, so there is no delisting path. saasmail
sidesteps it by sending the copy itself through your [configured outbound
provider](email-providers.md) — different IPs, and DKIM-signed for your own domain,
so it authenticates cleanly.

How the forwarded copy looks:

- **From** the inbox address, with the original sender named in the display name
  (`"Jane Customer (via Acme Support)" <support@acme.com>`). It cannot keep the
  original `From:` — sending as `jane@example.com` from your infrastructure would
  fail SPF and DMARC and get filtered harder than the block being avoided.
- **Reply-To** the original sender, so replying reaches the customer.
- Original `From` / `Date` / `Subject` / `Cc` and the SPF/DKIM/DMARC verdicts are
  restated in a header block at the top of the body.
- Attachments are included, up to your provider's size ceiling; anything too large
  is named in the body rather than silently dropped. Inline images arrive as regular
  attachments.
- The original `Cc` recipients are **not** re-sent to — only the destination is.

Forwarding is best-effort and never blocks inbound mail: it runs after the message
is safely stored, and after the blocklist and duplicate checks, so blocked senders
and duplicate deliveries are never forwarded. There is no retry — failures are
logged. Loops are prevented three ways: an inbox can't forward to itself, can't
forward to another inbox on the same instance, and any message already carrying the
`X-SaaSMail-Forwarded-For` header is never forwarded again.

---

**See also:** [Users and API keys](users-and-api-keys.md) for the permission model · [Webhooks](webhooks.md) to fire on inbound mail · [Email providers](email-providers.md)
