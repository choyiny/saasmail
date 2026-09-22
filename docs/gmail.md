[saasmail](../README.md) › [Docs](README.md) › **Gmail integration**

# Gmail integration

## Why this exists

A domain has exactly one set of MX records. If a root domain like `example.com`
already runs on Google Workspace, mail reaches Google and never reaches
Cloudflare Email Routing, so saasmail cannot receive it there. Rather than
competing for delivery, saasmail reads the mailbox through the Gmail API while
Google keeps handling delivery. That lets marketing and in-app email sent
through saasmail's API share a domain with ordinary human correspondence, and
land on one customer timeline.

## What this release ships

An admin can connect a Google mailbox, map it to a saasmail inbox, and its
mail starts appearing on that inbox's timeline — driven by direct API calls,
with no admin UI for any of it yet. Connecting, mapping, and disconnecting are
all done through the endpoints below.

- **Mail syncs on a 15-minute poll.** A cron tick reads each connected
  mailbox's history and ingests anything new. A message can take up to 15
  minutes to appear after it lands in Gmail — there is no push path in this
  release.
- **The first sync does not backfill.** Connecting a mailbox seeds the sync
  cursor at the mailbox's current position; it does not import anything that
  was already there. A newly connected mailbox shows an empty timeline that
  fills going forward only. This is expected, not a bug.
- **Personal mailboxes only.** One Gmail account maps to exactly one saasmail
  inbox. Google Group addresses are rejected — see
  [Google Groups aren't mailboxes](#google-groups-arent-mailboxes) below.
- **Replies now travel both ways for a mapped inbox.** A reply typed in
  saasmail to a Gmail-mapped inbox sends through that mailbox's real Gmail
  account instead of the configured provider — landing in its own Sent
  folder, threaded. A reply typed directly in Gmail appears on the customer
  timeline within the next poll (up to 15 minutes), mirrored from that
  mailbox's Sent folder. See
  [Sending through Gmail](#sending-through-gmail) below. Read state is still
  not written back to Gmail in either direction — that remains a later
  release.
- **Bulk and campaign mail never goes through Gmail.** New compose, template
  sends, and sequence steps always use the configured provider, even for a
  Gmail-mapped `fromAddress` — see
  [Sending through Gmail](#sending-through-gmail) for why.
- **A revoked grant stops that mailbox syncing** until it is reconnected. The
  account's `lastError` records what happened, and the connected-accounts
  route below surfaces it.
- **A long outage can lose mail permanently.** See
  [Sync gaps](#sync-gaps) below.

## Setup

1. Create a Google Cloud project inside the same Workspace organisation whose
   mail you want to read, and enable the Gmail API for it.
2. Create an OAuth client with an **Internal** consent screen (see
   [Internal-only, by design](#internal-only-by-design) below — this is not
   optional).
3. Add the redirect URI:

   ```
   <BASE_URL>/api/admin/gmail/callback
   ```

4. Set three Worker secrets:

   ```bash
   wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   # 32 random bytes, base64-encoded
   openssl rand -base64 32 | wrangler secret put TOKEN_ENCRYPTION_KEY
   ```

   `TOKEN_ENCRYPTION_KEY` must be exactly 32 bytes before base64 encoding — the
   command above produces exactly that. A key of the wrong length makes
   connecting fail.

5. Connect a mailbox and map it to an inbox by calling the API as an
   authenticated admin — this slice ships the HTTP endpoints only; a Connect
   control on the Inboxes page in the admin UI arrives in a later release.
   - `GET /api/admin/gmail/connect` returns `{ "authUrl": "..." }`. You can
     call this with an admin API key.
   - Open that `authUrl` **in a browser that is signed in to saasmail as an
     admin**. Google's consent screen redirects that same browser back to the
     callback URI from step 3, and the callback sits behind the same admin
     guard as every other `/api/admin/*` route. A browser navigation carries
     cookies, not an `Authorization` header, so an API key cannot stand in
     for the session here — without one the callback answers `403` and the
     mailbox is never connected. Sign in to the saasmail web app first, then
     paste the `authUrl` into that browser.
   - `GET /api/admin/gmail` lists connected mailboxes, each with `id`,
     `emailAddress`, `lastSyncedAt`, `lastError`, and `lastGapAt`. Check
     `lastGapAt` after any extended outage — see [Sync gaps](#sync-gaps).
   - Map the mailbox to a saasmail inbox with
     `PATCH /api/admin/inboxes/{email}`, body
     `{ "source": "gmail", "gmailAccountId": "<id from the list above>" }`.
     `{email}` is the saasmail inbox address that should receive this
     mailbox's mail — it does not need to already exist. Until an inbox is
     mapped this way, syncing for that mailbox is paused: the engine will not
     guess a destination, so it does not fetch or consume any history for the
     account. This is a safe, recoverable state, not data loss — the mail
     stays in Gmail and sync resumes exactly where it left off as soon as
     exactly one saasmail inbox is mapped to the account. While paused, the
     account's `lastError` records why (`no_personal_inbox` if nothing is
     mapped yet), and `GET /api/admin/gmail` surfaces it. The same pause
     applies if the mapping becomes _ambiguous_ — for example if a second
     saasmail inbox is also mapped to the same connected Google account —
     since the engine only ever routes to a single personal mailbox and
     refuses to pick between two (`lastError: ambiguous_inbox_mapping`). If
     sync looks stuck on a mailbox, check that it has exactly one inbox
     mapped to it.
   - `DELETE /api/admin/gmail/{id}` disconnects one: it deletes saasmail's
     stored row, including the encrypted refresh token, so saasmail can no
     longer reach the mailbox. It does **not** revoke the grant at Google —
     saasmail makes no revocation call. The refresh token stays valid on
     Google's side until the mailbox owner removes it by hand, under their
     Google Account's third-party access settings
     (<https://myaccount.google.com/connections>). Revoke it there too if the
     disconnect is a response to a compromise, or if the mailbox is leaving
     for good.

## Sending through Gmail

### Replies typed in saasmail

When a saasmail inbox is mapped to a Gmail account
(`PATCH /api/admin/inboxes/{email}` with `source: "gmail"`), a reply typed in
saasmail through `POST /api/send/reply/{emailId}` sends through that Gmail
account instead of the configured provider (Resend, Postmark, Bavimail, or
Cloudflare Email Sending). It:

- sends from the real Workspace address, not a look-alike;
- lands in that mailbox's own Gmail Sent folder;
- threads onto the Gmail conversation the original message belongs to, when
  saasmail knows one.

The reply is written to the timeline in the same request, so it doesn't wait
for a poll. Only replies take this path — new mail composed via `/api/send`,
template sends, and sequence steps always use the configured provider, even
when `fromAddress` is a Gmail-mapped inbox. See
[Bulk and campaign mail stays on the configured provider](#bulk-and-campaign-mail-stays-on-the-configured-provider)
below for why.

### Replies typed in Gmail

This is the consolidation the whole feature exists for. A reply someone types
directly in Gmail — from their own inbox, in their own client — is picked up
by the mailbox's Sent-folder mirror on the next 15-minute poll and appears on
the same customer timeline as everything else, threaded next to the messages
it answers. There is no separate mechanism for this: it is the same sync
described above, watching for the mailbox's own `SENT`-labeled mail alongside
inbound mail.

### Bulk and campaign mail stays on the configured provider

`/api/send` (new compose), template sends, and sequence steps always go out
through the configured provider — never through Gmail, even when
`fromAddress` is a Gmail-mapped inbox. Only
`POST /api/send/reply/{emailId}` ever uses Gmail as a transport.

This is deliberate, not a gap. Google Workspace caps sending at roughly 2,000
messages per day per user, and Gmail API sends count against that same cap.
Routing a campaign or a sequence step through Gmail would spend a real
person's mailbox quota on bulk mail — exhausting it, and risking that
Workspace account being flagged or throttled by Google for bulk-like
behaviour from what is supposed to be an individual's inbox. Keeping bulk
mail on the configured provider, which is built for volume, protects both the
send and the human who owns that Gmail account.

### A failed Gmail reply is not retried

Every other send in saasmail that fails is queued in the outbox and retried
automatically through the configured provider. A reply that fails to send
through Gmail is not: saasmail returns an error (`502`) and the reply is not
queued anywhere — no `sent_emails` row, no outbox row.

This is deliberate. The retry queue resends through the _configured_
provider, not Gmail, on its next tick — from a different identity,
DKIM-signed by a different service, absent from the Gmail Sent folder, and
unable to thread onto the Gmail conversation. Sending from the wrong mailbox
behind someone's back is worse than asking them to press send again. If you
see this error, the reply was not sent and is not in flight: send it again —
unless the error asks you to reconnect the mailbox, which means the Google
grant is dead and resending cannot work until you do (see below).

### A revoked grant degrades, it doesn't break

If `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` /
`TOKEN_ENCRYPTION_KEY` are unset, or the Google grant is revoked and saasmail
already knows it, a reply to a Gmail-mapped inbox falls back to the
configured provider — it just will not appear in that mailbox's Gmail Sent
folder or thread onto the Gmail conversation.

A revocation is discovered when saasmail next refreshes the access token,
which is either when the cached one expires or when Gmail rejects it
mid-send. In the mid-send case that first reply is **not** sent: saasmail
forces one token refresh, and when that fails it returns the `502` above with
an error telling you to reconnect the mailbox rather than to resend. The
account's `lastError` records the refresh failure and `GET /api/admin/gmail`
surfaces it, the same as it does for a sync failure. Replies after that take
the fallback. (Unset secrets are a configuration problem, not an account
one: they are logged, but nothing is written to `lastError`, because
saasmail never reaches the account row to write it.)

One caveat on the fallback. It sends through whichever provider is
configured, and **Cloudflare Email Sending currently keeps only the last `Cc`
recipient** — so a fallback reply Cc'd to several people reaches one of them.
Resend, Postmark and Bavimail all carry the full list. If your fallback
provider is Cloudflare Email Sending, treat a multi-`Cc` reply from a
Gmail-mapped inbox as unreliable until the grant is reconnected.

### No duplicates

saasmail's own Gmail replies come back through the Sent-folder mirror like
any other Gmail-typed reply. They are recognised by the Gmail message id
saasmail already recorded when it sent them, and skipped — so they never
appear twice on the timeline.

## Internal-only, by design

The consent screen must be **Internal**, not External. Gmail's scopes
(`gmail.modify`, `gmail.send`) are Google-classified as "restricted" —
an External consent screen requesting them requires Google's app verification
process plus a third-party security assessment, which is not something a
self-hosted, single-tenant tool can reasonably clear.

The consequence: this feature only works for an operator who owns the
Workspace organisation whose mail they're connecting. You cannot use it to
read a mailbox in someone else's Workspace.

## Google Groups aren't mailboxes

The Gmail API cannot read Google Groups. A Group has no Gmail mailbox of its
own, and the API's `users` resource requires a real user account. If a shared
address like `support@` is a Group rather than a user, there is nothing for
the Gmail API to read directly.

A "collector" account — a real Workspace user subscribed as a member of the
Group — works around that: Group mail delivered to members lands in the
collector's own mailbox, which the API can read normally. This slice does
**not** support that pattern, and the admin API actively rejects it:
`PATCH /api/admin/inboxes/{email}` returns `400` with

```json
{
  "error": "Google Group routing is not supported yet. Only personal mailboxes can be mapped to an inbox in this release."
}
```

if you try to set `gmailGroupAddress`. This isn't a "not implemented yet, try
anyway" gap — it was attempted and deliberately withdrawn. A collector's
mailbox holds mail for every Group it belongs to, so routing its messages to
the right saasmail inbox requires figuring out, per message, which Group it
came in on. The only signals available on the message itself for that —
`List-ID` and the `Delivered-To` header — are both attacker-controlled: an
outside sender can set `List-ID` directly, and can forge `Delivered-To` by
sending a second copy of that header, which collapses with Gmail's real one
under last-wins parsing. Either would let an attacker choose which of your
customers' timelines their message lands on. Security review couldn't close
that gap, so group routing was pulled rather than shipped weakened, and a
personal mailbox now maps 1:1 to exactly one saasmail inbox, with no
header-based routing at all — see `worker/src/lib/gmail/route-inbox.ts`.

If you need a shared inbox synced today, there is no supported way to do it
through Gmail. A trustworthy way to key group routing on something a sender
cannot control is planned for a later release.

## Sync gaps

Gmail's history API only retains about a week of history. Sync resumes from a
saved cursor each run; if a mailbox goes unpolled for longer than that —
Gmail integration disabled, a long Worker outage, the account stuck on
`lastError` — the cursor expires. When that happens, sync re-seeds at the
mailbox's _current_ position rather than failing forever, so the mailbox
starts syncing again on its own. But this means **mail that arrived inside
the gap is never synced and cannot be recovered**; there is no history left
to read it from.

`gmail_accounts.last_gap_at` records the last time this happened for an
account, and `GET /api/admin/gmail` exposes it as `lastGapAt`. Nothing ever
clears it — not a later successful sync, not reconnecting the mailbox — so
its age is the signal: check it after any extended outage or after
reconnecting a mailbox that had been failing, and treat a recent value as
"some mail from around then is permanently missing," not as a current-health
indicator.

## Rotating `TOKEN_ENCRYPTION_KEY`

Never rotate `TOKEN_ENCRYPTION_KEY` without reconnecting every mailbox first.
Every stored refresh token is sealed with this key, and changing it makes
those tokens permanently undecryptable — there is no recovery path other than
disconnecting and reconnecting each mailbox from scratch.

---

**See also:** [Configuration](configuration.md) for where the secrets live
