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

An admin can connect a Google mailbox from the **Inboxes** page, point a
saasmail inbox at it, and its mail starts appearing on that inbox's timeline.
Connecting, reconnecting, disconnecting, and mapping an inbox to a mailbox are
all done on `/inboxes` in the admin UI. The HTTP endpoints behind those
controls are unchanged and still usable directly — see
[Doing it over HTTP instead](#doing-it-over-http-instead).

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
- **A Gmail-mapped inbox that cannot reach Google refuses the reply.** It no
  longer quietly reroutes it through the configured provider — see
  [A broken grant refuses the reply](#a-broken-grant-refuses-the-reply-it-does-not-reroute-it).
- **Bulk and campaign mail never goes through Gmail.** New compose, template
  sends, and sequence steps always use the configured provider, even for a
  Gmail-mapped `fromAddress` — see
  [Sending through Gmail](#sending-through-gmail) for why.
- **A failing mailbox says so.** Any sync failure — a revoked grant, a Gmail
  outage, a rate limit — is written to the account's `lastError`; the mailbox
  list on `/inboxes` prints it, offers a **Reconnect** link for the failures a
  fresh grant can fix, and the connected-accounts route below returns it too.
- **A long outage can lose mail permanently.** See
  [Sync gaps](#sync-gaps) below.

## Setup

Setting this up on a local instance has extra steps — the redirect URI Google
has to accept, and how to trigger the sync cron without waiting for the real
tick. Those are in
[Gmail on a local instance](gmail-local-setup.md), step by step.

1. Create a Google Cloud project inside the same Workspace organisation whose
   mail you want to read, and enable the Gmail API for it.
2. Create an OAuth client with an **Internal** consent screen (see
   [Internal-only, by design](#internal-only-by-design) below — this is not
   optional). The application type must be **Web application**; no other
   client type accepts redirect URIs.
3. Add the redirect URI:

   ```
   <BASE_URL>/api/admin/gmail/callback
   ```

   `BASE_URL` is the `wrangler.jsonc` var, and saasmail builds the URI by
   appending that path to it. Google matches it character for character, so
   the two must agree exactly — including the scheme, the port, and
   `localhost` versus `127.0.0.1`. `BASE_URL` is a prerequisite for this
   feature even though nothing refuses to start without it: unset, saasmail
   sends Google a relative redirect URI and Google answers with its own error
   page.

4. Set three Worker secrets:

   ```bash
   wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   # 32 random bytes, base64-encoded
   openssl rand -base64 32 | wrangler secret put TOKEN_ENCRYPTION_KEY
   ```

   For local development these three go in `.dev.vars` instead, alongside
   `DISABLE_PASSKEY_GATE=true` — without that, the passkey gate refuses the
   OAuth callback like any other `/api/*` route and the mailbox is never
   stored. See [Gmail on a local instance](gmail-local-setup.md).

   `TOKEN_ENCRYPTION_KEY` must be exactly 32 bytes before base64 encoding — the
   command above produces exactly that. A key of the wrong length does not stop
   the flow starting: connecting begins normally and fails at the **callback**,
   which returns a bare `?gmail=error` with the reason only in the Worker log.

5. Apply the migrations (`yarn db:migrate:dev` locally,
   `yarn db:migrate:prod` for a deployed instance). This feature needs `0035`
   through `0041`.

   **One upgrade caveat.** `0041` makes
   `sent_emails (gmail_message_id, from_address)` unique, and SQLite refuses
   to build a unique index over data that already violates it. A fresh
   install cannot hit this. An instance that ran an **earlier build of this
   feature** can, because the duplicate Sent mirrors that index exists to
   prevent were possible then. Check before applying:

   ```bash
   wrangler d1 execute saasmail-db --remote --command \
     "select gmail_message_id, from_address, count(*) c from sent_emails \
      where gmail_message_id is not null \
      group by gmail_message_id, from_address having c > 1"
   ```

   Any rows returned are duplicate mirrors of one Gmail message on one
   timeline; delete all but one of each group, then re-run the migration.

6. Sign in to the saasmail web app as an admin and open **Inboxes**
   (`/inboxes`). The rest of the setup happens there — see
   [Connecting a mailbox](#connecting-a-mailbox) and
   [Pointing an inbox at a mailbox](#pointing-an-inbox-at-a-mailbox).

## Connecting a mailbox

**Connected Google mailboxes** sits at the top of the **Inboxes** page. With
nothing connected it explains that connecting does not backfill; otherwise it
lists each connected mailbox with its address and when it last synced, plus
**Disconnect** and — only when that mailbox has an error a fresh grant could
fix — **Reconnect**.

**Connect a Google mailbox** starts the OAuth flow. The button asks
`GET /api/admin/gmail/connect` for a consent URL — that endpoint answers
`{ "authUrl": … }` with a `200` rather than redirecting — and then sends the
browser to it. If that call fails, the page says so and stays put rather than
navigating; on an instance with no OAuth secrets that reads "Gmail
integration is not configured".

Use a browser that is signed in to saasmail as an admin — Google redirects
back to the callback from step 3, which sits behind the same admin guard as every
other `/api/admin/*` route, and a browser navigation carries cookies rather
than an `Authorization` header, so an API key cannot stand in for the session
here. Without a session the callback answers `401`; with a session belonging
to a non-admin it answers `403`. Either way the mailbox is never connected.
A third case looks the same from the browser: on a local instance without
`DISABLE_PASSKEY_GATE=true`, an admin who has not registered a passkey is
refused with `403` before the callback runs at all.

Google then returns you to `/inboxes` with the result in the URL, and the page
shows a banner for it:

- `?gmail=connected` — the mailbox is in the list below; the first sync runs
  within 15 minutes, and only mail arriving from now on is pulled in.
- `?gmail=error` — nothing was added, try again. The banner deliberately does
  not print the reason; it is in the Worker log, because the underlying error
  can carry the access token.
- `?gmail=wrong_account` — you were reconnecting one mailbox and granted
  access as another, so nothing was written. Only a per-mailbox **Reconnect**
  can produce this; see [What a Reconnect prompt means](#what-a-reconnect-prompt-means).
- `?gmail=wrong_admin` — the flow was started by a different administrator.
  The signed `state` names the admin who began it, and the callback requires
  the session finishing it to be the same one, so a consent flow cannot be
  completed in somebody else's browser. Nothing was written and the
  authorization code was not spent; start the flow again from your own
  account. A state lives ten minutes, so this is otherwise invisible.

The parameter is stripped from the URL once read, so a refresh does not
resurrect a stale banner.

**The OAuth `state` expires after ten minutes** (plus 60 seconds of allowed
clock skew). A consent screen left open longer than that comes back as a bare
`?gmail=error` with nothing to distinguish it from any other failure; start
the flow again. The same banner is also what you get when Google returns no
refresh token — saasmail refuses a grant it cannot refresh rather than storing
a connection that dies with the first access token.

### What a Reconnect prompt means

A mailbox with a non-null `lastError` gets a red note — _"This mailbox has
stopped syncing…"_ — and the error's own code, printed verbatim. Sync has
stopped for that mailbox and will not resume on its own.

**Reconnect is offered only for the errors a fresh grant can actually fix**:
a revoked or broken grant, and anything else Google reports, since that set
is open-ended. For the codes saasmail raises itself the button is hidden
and the note says what to do instead, because a consent round trip would
change nothing:

- `no_personal_inbox` — no saasmail inbox is mapped to this mailbox yet. Map
  one (below).
- `ambiguous_inbox_mapping` — more than one saasmail inbox is mapped to this
  mailbox, and the engine refuses to pick. Leave exactly one.
- `history_gap` — sync already recovered by re-seeding from the present; the
  next successful sync clears this. Mail from inside the gap is gone — see
  [Sync gaps](#sync-gaps).
- `message_failed:<id>` — one message threw. The cursor did not move, so the
  next run retries it.
- `sync_failed:<code>` — the whole run failed before it could sync anything:
  a Gmail 5xx (`sync_failed:http_500`), a rate limit
  (`sync_failed:rate_limited`), or an unclassified error
  (`sync_failed:unknown`). Neither the cursor nor `lastSyncedAt` moved, so
  the next run picks up where this one left off. The two exceptions are
  `sync_failed:http_401` and `sync_failed:http_403` — Gmail refusing the
  credential itself — which **do** offer Reconnect: that is how a grant
  revoked while the cached access token was still valid shows up.

The code is all that is recorded. An error's own message never reaches
`lastError`, because this field is returned by the admin API and rendered in
the UI, and a D1 error's message carries the parameters bound to its query —
which on this path include the access token. The message goes to the Worker
log instead.

Reconnecting runs the OAuth flow again **for that specific mailbox**: its
address is sent to Google as a `login_hint` so the right account is
pre-selected, and it is sealed into the signed `state`. If you end up
granting access as a different Google account anyway — easy to do when the
browser is signed in as someone else — the callback **writes nothing** and
returns to `/inboxes?gmail=wrong_account`, naming the mailbox you were
reconnecting and the one you granted. That refusal matters: upserting the
grant you actually gave would replace a different, possibly healthy
mailbox's credentials and reset _its_ sync cursor.

A successful reconnect replaces the mailbox's stored credentials, clears
`lastError`, and re-seeds the sync cursor at the mailbox's _current_ position
— so mail that arrived while the mailbox was broken is not fetched
afterwards, exactly as a first connection does not backfill. Because that
mail is unrecoverable, **a reconnect records a sync gap** (`lastGapAt`) and
the mailbox's row shows the amber notice from then on. It does not clear an
earlier gap either; see below.

While a mailbox is unmapped or ambiguously mapped, sync is _paused_ rather
than lossy: the engine does not fetch or consume any history for the account,
so the mail stays in Gmail and sync resumes exactly where it left off once
exactly one saasmail inbox is mapped to it. If sync looks stuck on a mailbox,
check its mapping first.

### Disconnecting

**Disconnect** arms an inline confirm rather than acting immediately.
Confirming deletes saasmail's stored row, including the encrypted refresh
token, so saasmail can no longer reach the mailbox; mail already synced stays
on the timeline. Any inbox that read from that mailbox is switched back to
**Cloudflare** in the same request, since a mapping pointing at a deleted
mailbox is an inbox that silently receives nothing.

It also **forgets the Gmail thread ids** stored against those inboxes. Gmail
thread ids are per-mailbox, so an id issued by the mailbox you just
disconnected is a claim the next mailbox cannot honour — handing one to a
different account's send endpoint is a `4xx`, and a `4xx` from Gmail is
terminal and never queued, which would leave every pre-existing conversation
permanently unreplyable. Clearing them costs the Gmail-side threading on those
old conversations: replies start a new Gmail thread. The saasmail timeline
groups by person and conversation, not by this id, so nothing moves there.

It does **not** revoke the grant at Google — saasmail makes no revocation
call, whatever the confirm text says. The refresh token stays valid on
Google's side until the mailbox owner removes it by hand under their Google
Account's third-party access settings
(<https://myaccount.google.com/connections>). Revoke it there too if the
disconnect is a response to a compromise, or if the mailbox is leaving for
good.

## Pointing an inbox at a mailbox

Each row in the inbox table below has a **Source** dropdown: **Cloudflare**
(the default — mail arrives through Cloudflare Email Routing) or one of the
connected Google mailboxes, listed by address. Choosing a mailbox saves
immediately.

With no mailbox connected the dropdown is disabled and reads "Connect a Google
mailbox first" — or "Couldn't load connected mailboxes" if that list failed to
load, which is not the same thing.

**Re-pointing an inbox at a different mailbox, or unmapping it, forgets that
inbox's stored Gmail thread ids**, for the same reason
[Disconnecting](#disconnecting) does. Replies on conversations that predate
the change start a new Gmail thread instead of failing forever.

A mapped row says which of three things is true, because confusing them would
talk you into unmapping a working inbox:

- **The mailbox's address** — the list is current and the mapping resolves.
  Normal.
- **"Mailbox no longer connected"** — the list loaded and this mapping's
  mailbox is genuinely not in it. Pick another mailbox, or Cloudflare.
- **"Couldn't check — still mapped to `<id>`"** — the list could not be
  loaded at all, so this mapping cannot even be named. The mapping is
  probably fine.

**Whenever the mailbox list failed to load, every mapped row is locked** —
including one the last good list can still name, which keeps showing its
address rather than an opaque id. Changing a mapping is a real `PATCH`, and a
list we know to be out of date cannot tell a live mapping from a dead one.
Reload before changing anything. The list is re-read after a connect or a
disconnect as well as on first load, so a blip on either can produce this.

### A mapping is verified before it is saved

saasmail asks Gmail for the connected account's "Send mail as" list and
refuses the mapping unless the inbox address is one that account can actually
send from (which is not quite the same as being on the list — see below). The
check runs whenever
the mapping is new or changed — not on unrelated edits to the same inbox, so a
Gmail outage cannot block renaming an inbox.

It keys on the mapping the request would **result** in, not on which fields
the request happened to carry. `source` and `gmailAccountId` are one fact:
naming a mailbox is choosing Gmail, and choosing Cloudflare gives the mailbox
up. A body that contradicts itself — `"source": "cloudflare"` together with a
`gmailAccountId` — is refused with a `400` before Google is contacted. So a
`PATCH` carrying only `gmailAccountId` is verified exactly like one carrying
both fields.

Three refusals are possible, and
they need different things from you. In each case **nothing is saved**, the
dropdown snaps back, and the server's own message is printed under it:

| Status | Means                                                       | What to do                                                                                             |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `400`  | The account cannot send as this address                     | Add the address under **Send mail as** in that Gmail account, **verify it**, then map the inbox again. |
| `502`  | The check itself could not be completed (Gmail unreachable) | Retry. Nothing about your configuration is wrong.                                                      |
| `503`  | Gmail integration is not configured on this instance        | Set the three secrets from step 4. Retrying will not help until you do.                                |

The `400` catches a mapping that would otherwise look fine and then die on the
first real reply. One thing to know about it: **an address can be in the "Send
mail as" list and still be refused.** saasmail drops every entry Gmail reports
with `verificationStatus: "pending"` — an alias you added but have not
confirmed from the verification mail — because Gmail will not send from one.
That is the only status dropped: the account's own address and
Workspace-managed aliases, which Gmail reports as
`verificationStatusUnspecified` or with no status at all, are all accepted. So
if a `400` names an address you can see under **Send mail as**, check that its
verification actually completed.

## Doing it over HTTP instead

Every control above is a call you can make yourself, as an authenticated
admin:

- `GET /api/admin/gmail/connect` → `{ "authUrl": "..." }`. You can call this
  with an admin API key, but the `authUrl` must then be opened in a browser
  signed in to saasmail — see [above](#connecting-a-mailbox). Pass
  `?email=<address>` to reconnect one specific mailbox: the address becomes
  Google's `login_hint` and is sealed into the signed `state`, and the
  callback refuses to write anything if a different account is granted.
- `GET /api/admin/gmail` lists connected mailboxes, each with `id`,
  `emailAddress`, `lastSyncedAt`, `lastError`, `lastGapAt`, `createdAt`, and
  `connectedBy` — `{ id, name, email }` for the admin who last connected or
  reconnected it. `connectedBy` is null on a mailbox connected before saasmail
  recorded it, and its `name`/`email` are null if that admin has since been
  deleted: the column holds an id, not a foreign key, so the mailbox outlives
  the account. The mailbox row on `/inboxes` renders this as "Added 3 days ago
  · last connected by Jane Ops".
  It never returns token material. `lastSyncedAt` advances on every completed
  run, **including one that found no new mail** — so a moving `lastSyncedAt`
  proves the cron fired and the grant still works, not that anything arrived.
  Check `lastGapAt` after any extended outage — see
  [Sync gaps](#sync-gaps).
- `PATCH /api/admin/inboxes/{email}` with
  `{ "source": "gmail", "gmailAccountId": "<id from the list above>" }` maps
  an inbox; `{email}` does not need to already exist. Sending `"cloudflare"`
  as the source, with `gmailAccountId` set to `null`, unmaps it. The same
  `400` / `502` / `503` refusals apply, plus a `400` for `"source": "gmail"`
  with no `gmailAccountId` — a Gmail inbox has to name the mailbox it reads
  from, and there would be nothing to run the send-as check against.
- `DELETE /api/admin/gmail/{id}` disconnects one mailbox and unmaps the
  inboxes that read from it, with the same no-revocation caveat as
  [Disconnecting](#disconnecting).

## Sending through Gmail

### Replies typed in saasmail

When a saasmail inbox is mapped to a Gmail account (its **Source** on
`/inboxes` set to that mailbox), a reply typed in
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

**A reply typed in Gmail cancels that person's active sequences**, exactly as
an inbound reply or a reply typed in saasmail does. A rep who answers a lead
from their phone has made contact, so the automated follow-ups stop; without
this the customer keeps getting nudged about a question a human already
answered. It only applies when saasmail recognises the recipient — a message
to an address it has never heard from has no timeline and no enrollments to
cancel. See [Sequences](sequences.md).

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

### A broken grant refuses the reply; it does not reroute it

**This behaviour was reversed.** A Gmail-mapped inbox whose token cannot be
obtained used to fall back to the configured provider. It no longer does: the
reply is **refused with a `502`, nothing is written, nothing is queued, and
the composer keeps the draft**. If you were relying on the old fallback, this
is the change to know about.

The fallback was dishonest in both directions. On a Gmail-only install there
is no configured provider, so the outbox marked the row failed while the API
answered `201` and the composer cleared the draft — nothing sent, and the user
told it was. On an install that does have Resend or Postmark it is worse: the
reply leaves from a real Workspace address through a service that domain's
SPF/DKIM does not authorise, fails DMARC, and is retried every fifteen
minutes.

The line is drawn on the mapping, not on the error. An inbox that is **not**
Gmail-mapped still uses the configured provider with no fuss, because that
provider genuinely is its transport — including when the three OAuth secrets
are unset, which makes no inbox Gmail-mapped at all. An inbox that **is**
Gmail-mapped and cannot produce a token is refused: a revoked grant, a
mailbox that was disconnected while an inbox still pointed at it, or Google
being unreachable.

A revocation is discovered when saasmail next refreshes the access token,
which is either when the cached one expires or when Gmail rejects it
mid-send. Either way that reply is refused with the `502` above and an error
telling you to reconnect the mailbox rather than to resend. The account's
`lastError` records the refresh failure and `GET /api/admin/gmail` surfaces
it, the same as it does for a sync failure. (Unset secrets are a
configuration problem, not an account one: they are logged, but nothing is
written to `lastError`, because saasmail never reaches the account row to
write it.)

When a reply does go out through the configured provider, all four — Resend,
Postmark, Bavimail, and Cloudflare Email Sending — carry the full `Cc` list.
(Cloudflare Email Sending used to keep only the last `Cc` recipient; that is
fixed.)

### A `2xx` with no message id counts as delivered

If Gmail accepts a reply but returns no message id, saasmail treats it as
**delivered**, not as something to retry, and the error it returns says so
instead of telling you to send it again — a resend would put a second copy of
a real reply in the customer's mailbox. What is lost is saasmail's own
`sent_emails` record of it; the Sent-folder mirror puts the message back on
the timeline on the next poll.

### No duplicates

saasmail's own Gmail replies come back through the Sent-folder mirror like
any other Gmail-typed reply. They are recognised by the Gmail message id
saasmail already recorded when it sent them, and skipped — so they never
appear twice on the timeline.

## Limits

None of these are configurable, and each of them has been reported as a bug
at least once.

- **50 messages per mailbox per cron run.** A backlog drains at 50 every 15
  minutes — roughly 200 an hour — rather than all at once, so a large first
  day looks stalled when it is only queued. The Worker log says so:
  `hit the 50-message cap; resuming after history record …`. Nothing is lost;
  the cursor stops at the last record processed in full and the next run
  resumes from there.
- **`DRAFT`, `TRASH` and `SPAM` messages are skipped**, and that skip beats
  the Sent mirror — a message that was sent and then trashed is dropped
  rather than mirrored.
- **Only newly added messages are polled.** The sync asks Gmail's history API
  for `messageAdded` and nothing else, so label changes, and mail a filter
  moves into the mailbox after it arrived, are never seen.
- **A mirrored Sent message whose first recipient is not a plain address is
  skipped silently.** It counts as a skip; nothing is written to `lastError`.
- **Gmail replies cap attachments at about 14 MiB.** Gmail's own ceiling is a
  25 MB message, but the send endpoint carries the whole RFC822 message
  base64url-encoded inside a JSON body and the attachment is already base64
  inside that message, so a byte of attachment costs about 1.78 bytes on the
  wire. saasmail budgets against the encoded size. A Gmail-mapped inbox
  therefore has a **different**, lower attachment ceiling than the configured
  provider, and because a Gmail reply is never queued, a `413` here is a dead
  end rather than something to retry.
- **The OAuth `state` lives ten minutes** (plus 60 seconds of clock skew).
- **Google Workspace caps sending at roughly 2,000 messages per day per
  user**, and Gmail API sends count against it. That cap is why bulk mail
  never takes this path — see
  [Bulk and campaign mail stays on the configured provider](#bulk-and-campaign-mail-stays-on-the-configured-provider).

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

A sync gap is any point where the cursor jumps forward to the mailbox's
current position, leaving whatever had not been fetched yet unfetchable.
**Two things cause one: an expired history cursor, and reconnecting the
mailbox.** Both are recorded the same way, because both lose mail the same
way.

Gmail's history API only retains about a week of history. Sync resumes from a
saved cursor each run; if a mailbox goes unpolled for longer than that —
Gmail integration disabled, a long Worker outage, the account stuck on
`lastError` — the cursor expires. When that happens, sync re-seeds at the
mailbox's _current_ position rather than failing forever, so the mailbox
starts syncing again on its own. But this means **mail that arrived inside
the gap is never synced and cannot be recovered**; there is no history left
to read it from.

Reconnecting a mailbox does the same thing deliberately: the fresh grant
takes a new cursor from the mailbox's current head, so anything that arrived
while the grant was dead is skipped. That is unavoidable — there is no
recovering it — but it is not silent: the reconnect stamps `lastGapAt` too.

`gmail_accounts.last_gap_at` records the last time this happened for an
account, in unix seconds. `GET /api/admin/gmail` exposes it as `lastGapAt`,
and the mailbox's row on `/inboxes` shows an amber **Sync gap** notice, with
how long ago it happened, saying that mail from that window was never synced
and cannot be recovered in saasmail — it is still in Gmail.

**That notice never goes away, and that is deliberate.** Nothing clears
`lastGapAt`: not a later successful sync, and not reconnecting the mailbox —
a reconnect stamps a new one instead. Reconnecting clears the `lastError`
that prompted it, but it does not un-lose the mail, so the gap stays on the
record. Its age is the signal —
treat a recent value as "some mail from around then is permanently missing",
and an old one as history, not as a current-health indicator.

## Rotating `TOKEN_ENCRYPTION_KEY`

Never rotate `TOKEN_ENCRYPTION_KEY` without reconnecting every mailbox first.
Every stored refresh token is sealed with this key, and changing it makes
those tokens permanently undecryptable — there is no recovery path other than
disconnecting and reconnecting each mailbox from scratch.

---

**See also:** [Gmail on a local instance](gmail-local-setup.md) for a step-by-step local setup · [Configuration](configuration.md) for where the secrets live · [Inboxes and timelines](inboxes.md) for the rest of the Inboxes page
