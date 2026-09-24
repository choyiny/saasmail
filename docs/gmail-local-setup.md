[saasmail](../README.md) › [Docs](README.md) › **Gmail on a local instance**

# Gmail on a local instance

How to get a Google Workspace mailbox syncing into a saasmail running on your
own machine. [Gmail integration](gmail.md) explains what the feature does and
why; this page is the sequence of steps that makes it work locally, including
the two things that only matter locally — the redirect URI Google must accept,
and how to fire the sync cron without waiting fifteen minutes.

Everything here assumes a working local checkout: `yarn install`,
`wrangler login`, `cp wrangler.jsonc.example wrangler.jsonc`,
`cp .dev.vars.example .dev.vars`. See [Setup](setup.md) if you have not got
that far.

## Before you start

- **You must administer the Workspace organisation whose mail you are
  reading.** Gmail's scopes are Google-classified as restricted, so the OAuth
  consent screen has to be **Internal** — see
  [Internal-only, by design](gmail.md#internal-only-by-design). There is no
  way to connect a mailbox in someone else's Workspace.
- **Cloudflare Email Routing cannot deliver to a local worker.** Locally, a
  Gmail-mapped inbox is the only way to see real inbound mail arrive; for
  everything else the local database is seeded by hand
  (`yarn db:seed:dev`, see [Local development](development.md)).
- Budget ten minutes in the Google Cloud console and ten in saasmail.

## Step 1 — Google Cloud

1. Create a Google Cloud project **inside the Workspace organisation whose
   mail you want to read**, and enable the **Gmail API** for it. That is the
   only API this feature calls.
2. OAuth consent screen → **Internal**. External would require Google's app
   verification plus a third-party security assessment, because of the
   restricted scopes; that is not something a self-hosted single-tenant tool
   can clear.
3. Credentials → **Create credentials** → **OAuth client ID** → application
   type **Web application**. It has to be this type: no other OAuth client
   type accepts redirect URIs.
4. Under **Authorized redirect URIs**, add the local one:

   ```
   http://localhost:8080/api/admin/gmail/callback
   ```

   Add the deployed one alongside it if the same client will serve both:

   ```
   https://<your-deployed-host>/api/admin/gmail/callback
   ```

   saasmail builds this URI by appending `/api/admin/gmail/callback` to
   `BASE_URL`, and Google matches it character for character. `8080` is the
   port `yarn dev` serves on. Google also treats `http://127.0.0.1` as a
   different host from `http://localhost` — if you browse to one, register
   that one.

5. Scopes: saasmail requests `gmail.modify` and `gmail.send`, and nothing
   else. You do not add them in the console — they are in the consent URL
   saasmail builds.

## Step 2 — Secrets and env

Three secrets, plus two `wrangler.jsonc` values that are easy to miss.

### `.dev.vars` (local) / `wrangler secret put` (deployed)

```bash
# .dev.vars
GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=...
TOKEN_ENCRYPTION_KEY=...          # openssl rand -base64 32
DISABLE_PASSKEY_GATE=true
```

`TOKEN_ENCRYPTION_KEY` must decode to **exactly 32 bytes** — `openssl rand
-base64 32` produces exactly that, and anything else is rejected with
"TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded". The same key does two
jobs: it seals stored refresh tokens with AES-GCM, and it is the HMAC secret
signing the OAuth `state`. Never rotate it without reconnecting every mailbox
— see [Rotating `TOKEN_ENCRYPTION_KEY`](gmail.md#rotating-token_encryption_key).

`DISABLE_PASSKEY_GATE=true` is not optional locally. Without it, every
`/api/*` route refuses a session-cookie user who has not registered a passkey
— and Google's redirect back from the consent screen lands on
`/api/admin/gmail/callback`, which is one of those routes. You would complete
consent and never get a mailbox.

For a deployed instance the same three Gmail values go in as Worker secrets
instead:

```bash
wrangler secret put GOOGLE_OAUTH_CLIENT_ID
wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
openssl rand -base64 32 | wrangler secret put TOKEN_ENCRYPTION_KEY
```

`DISABLE_PASSKEY_GATE` is local-only. Never set it in production.

### `wrangler.jsonc`

```jsonc
"vars": {
  "BASE_URL": "http://localhost:8080",
  "TRUSTED_ORIGINS": "http://localhost:8080,http://localhost:8788",
}
```

`BASE_URL` lives in `wrangler.jsonc` `vars`, not in `.dev.vars`, and it is a
Gmail prerequisite even though no route refuses to start without it.
[Setup](setup.md) tells you to point `BASE_URL` at your deployed URL — if you
leave it there while working locally, the consent URL saasmail builds carries
your **production** callback, and Google will send you there instead of back
to your machine.

`wrangler.jsonc.example` also carries the cron this feature rides on. Leave it
alone:

```jsonc
"triggers": { "crons": ["*/15 * * * *"] }
```

Restart `yarn dev` after editing either file.

### What breaks if each one is missing

| Missing                                           | Symptom                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any of the three Gmail secrets                    | **Connect a Google mailbox** fails with `503 "Gmail integration is not configured"`; mapping an inbox returns the same `503`; the cron sync silently does nothing; a reply from a Gmail-mapped inbox falls back to the configured provider with only a log line |
| `TOKEN_ENCRYPTION_KEY` of the wrong length        | Connect **starts** normally — the state is HMAC'd with any-length key — and fails at the callback. You land on `/inboxes?gmail=error` with no explanation; the reason is in the `yarn dev` terminal only                                                        |
| `BASE_URL` unset, or still pointing at production | No `503`. Google answers with its own `redirect_uri_mismatch` (or sends you to your production host). Nothing in saasmail reports it                                                                                                                            |
| `DISABLE_PASSKEY_GATE`                            | The callback is refused with `403` before it can store anything, if your admin user has no passkey registered                                                                                                                                                   |

## Step 3 — Local runtime

```bash
# Apply migrations to the local D1 (creates it on first run)
yarn db:migrate:dev

# Start the worker and the SPA together, on http://localhost:8080
yarn dev
```

The Gmail feature needs migrations `0035` through `0041`. `yarn db:migrate:dev`
applies whatever is outstanding.

Then open `http://localhost:8080` and sign in as an **admin**. On a fresh local
database, the first account you create through the first-run screen is the
admin.

### Firing the sync cron by hand

There is no admin route, no button and no yarn script that syncs one mailbox.
The worker's `scheduled` handler is the only thing that calls the Gmail sync,
so without a manual trigger every test iteration costs up to fifteen minutes.

The Vite dev server forwards Miniflare's trigger endpoint, so a request to it
runs the scheduled handler immediately:

```bash
curl "http://localhost:8080/cdn-cgi/mf/scheduled"
```

**This is verified from the plugin and Miniflare sources, not executed** — no
local dev server was running when this page was written. Confirm it on your
first run: a successful trigger answers with the body `ok` and a `200`, and
the `yarn dev` terminal prints the sync's own log lines. A `404`, HTML, or the
saasmail SPA coming back means the request did not reach the handler; in that
case fall back to waiting for the real 15-minute tick. The endpoint also
accepts `?cron=…` and `?time=<unix-ms>` to set what the handler sees, and
`?format=json` for a JSON outcome.

That request fires the **whole** scheduled handler, not just Gmail: sequence
dispatch, then outbox processing, then the sync of every connected mailbox. On
a local instance with seeded sequence data, expect those to run too.

## Step 4 — Connect a mailbox

1. Go to **Inboxes** (`/inboxes`) in the browser you are signed into saasmail
   with, as an admin.
2. **Connect a Google mailbox** in the **Connected Google mailboxes** section.
   The button asks the API for a consent URL and then navigates there itself —
   it is not a redirect, so if the call fails the page says so and stays put.
3. Grant consent as the mailbox owner.
4. Google returns you to `/inboxes` with the result in the URL.

Success looks like a row in **Connected Google mailboxes** showing the
address, a provenance line — "Added 3 days ago · last connected by Jane Ops" —
and **"Not synced yet — the first sync runs within 15 minutes."**

Failure banners:

- `?gmail=error` — nothing was written. The reason is deliberately not
  printed, because the underlying error can carry the access token; grep the
  `yarn dev` terminal for `[gmail] OAuth callback failed:`.
- `?gmail=wrong_account` — you were reconnecting one mailbox and granted a
  different one. Nothing was written.
- `?gmail=wrong_admin` — the flow was started by a different administrator.
  Start it again from your own account.

The OAuth `state` lives **ten minutes** (plus 60 seconds of clock skew). A
consent screen left open longer than that comes back as a bare `?gmail=error`.

## Step 5 — Map an inbox, before the first tick

On the inbox table below, each row has a **Source** dropdown. Pick the mailbox
you just connected; it saves immediately. Success is the dropdown showing the
mailbox address with no red text under it.

**Do this before the first cron tick.** A connected mailbox with no inbox
mapped to it records `lastError = no_personal_inbox` on its first run — which
is correct, harmless behaviour (no history is consumed, no mail is lost) but
means a brand-new mailbox's first visible state is a red error box.

Map **exactly one** inbox to a mailbox. Two is `ambiguous_inbox_mapping`, and
sync stalls rather than guessing.

The mapping is verified against what the connected account can actually send
as, before it is saved. The three refusals and what each needs are in
[A mapping is verified before it is saved](gmail.md#a-mapping-is-verified-before-it-is-saved):
`400` (the account cannot send as that address), `502` (the check could not be
completed), `503` (Gmail integration is not configured).

## Step 6 — Confirm it works

1. Send a mail **into** the Gmail mailbox from an outside address.
2. Fire the cron (step 3), or wait up to fifteen minutes.
3. Check the account: `GET /api/admin/gmail` as an admin. `lastSyncedAt`
   should have moved and `lastError` should be null.
4. The message should be on the customer's timeline under the mapped inbox.
5. Reply from saasmail. It should appear in that Gmail account's own **Sent**
   folder, threaded.
6. Reply **in Gmail**. Fire the cron again; it should land on the same
   timeline.

`lastSyncedAt` advances on every completed run, including a run that found no
new mail — so a moving `lastSyncedAt` proves the cron fired and the grant
works, not that mail arrived.

Raw state, if you want to look at the row directly:

```bash
wrangler d1 execute saasmail-db --local --command \
  "select email_address, history_id, last_synced_at, last_error, last_gap_at from gmail_accounts"
```

## Step 7 — When it is not working

| Symptom                                                    | Look at                                                                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connect a Google mailbox** errors, "not configured"      | `/connect` answered `503` — one of the three Gmail secrets is missing from `.dev.vars`. Restart `yarn dev` after adding them                                                                        |
| Google shows `redirect_uri_mismatch`                       | `BASE_URL` does not match a registered redirect URI, character for character. Check `localhost` vs `127.0.0.1` and the port too                                                                     |
| Google sends you to your production host                   | `BASE_URL` in `wrangler.jsonc` is still the deployed URL                                                                                                                                            |
| Back at `/inboxes?gmail=error`                             | Terminal, `[gmail] OAuth callback failed:` — a wrong-length `TOKEN_ENCRYPTION_KEY`, a state older than ten minutes, or Google returning no refresh token                                            |
| `?gmail=wrong_account`                                     | A Reconnect granted a different Google account. Nothing was written                                                                                                                                 |
| `?gmail=wrong_admin`                                       | The consent flow was started by another admin. Restart it yourself                                                                                                                                  |
| The callback 403s                                          | `DISABLE_PASSKEY_GATE=true` is missing and your admin has no passkey                                                                                                                                |
| The mailbox list says "Couldn't load…"                     | A real `401`/`403` from the API — check you are signed in as an admin                                                                                                                               |
| `lastError: no_personal_inbox` / `ambiguous_inbox_mapping` | The mapping, not the grant. Reconnect will not help — map exactly one inbox                                                                                                                         |
| `lastError: sync_failed:<code>`                            | The run failed before syncing anything. `http_401`/`http_403` mean the credential was refused — reconnect. Everything else (`http_500`, `rate_limited`, `unknown`) resolves itself or needs the log |
| `lastError: history_gap` + amber notice                    | The cursor expired and was re-seeded. Mail inside the window is gone; the notice never clears                                                                                                       |
| `lastError: message_failed:<id>`                           | One message threw. The cursor is parked before it and retries every tick; open that id in Gmail                                                                                                     |
| Nothing ever appears                                       | Did the cron actually run? Is the inbox mapped? Is `lastSyncedAt` moving?                                                                                                                           |

Log lines worth grepping in the `yarn dev` terminal (or `wrangler tail` for a
deployed instance): `[gmail] OAuth callback failed:`, `Gmail sync for `,
`Gmail history expired for`, `[createSenderForInbox]`,
`[admin-inboxes] could not verify the Gmail mapping`.

## Step 8 — Limits, and what is not a bug

Things that look broken and are not:

- **Sync polls every 15 minutes. There is no push.** A message can take that
  long to appear.
- **Connecting never backfills.** The cursor is seeded at the mailbox's
  current position, so the timeline starts empty and fills forward only.
- **50 messages per mailbox per run.** A backlog drains at roughly 200 an
  hour, over several ticks; the terminal logs "hit the 50-message cap;
  resuming after history record …". Not a stall.
- **`DRAFT`, `TRASH` and `SPAM` messages are skipped**, and that skip wins
  over the Sent mirror — a message sent and then trashed is not mirrored.
- **Only newly added messages are polled.** Label changes, and mail moved
  into the mailbox by a filter after it arrived, are never seen.
- **A reply typed in Gmail cancels that person's active sequences**, exactly
  as an inbound reply does.
- **Gmail replies cap attachments at about 14 MiB**, which is lower than the
  configured provider's ceiling — Gmail's 25 MB message limit, minus two
  rounds of base64.
- **A failed Gmail reply is not queued or retried.** Send it again by hand.
- **Google Groups and shared addresses are not supported**, and the API
  rejects the collector pattern outright — see
  [Google Groups aren't mailboxes](gmail.md#google-groups-arent-mailboxes).
- **Read state is never written back to Gmail**, in either direction.
- **Bulk, template and sequence sends never use Gmail.** Only
  `POST /api/send/reply/{emailId}` does, to protect the Workspace account's
  ~2,000/day sending quota.

---

**See also:** [Gmail integration](gmail.md) · [Configuration](configuration.md) · [Local development](development.md) · [Setup](setup.md)
