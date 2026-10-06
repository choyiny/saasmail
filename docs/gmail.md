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

This is the credential layer only, driven by direct API calls — no admin UI
ships in this slice. An admin can connect a Google mailbox, list connected
mailboxes, and disconnect one — the refresh token is stored encrypted. **No
mail is synced yet.** Message sync, the send path, and mapping a Gmail
mailbox to a saasmail inbox arrive in later releases. Connecting a mailbox
today does not make its mail appear anywhere in saasmail.

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

5. Connect a mailbox by calling the API as an authenticated admin — this
   slice ships the HTTP endpoints only; a Connect control on the Inboxes
   page in the admin UI arrives in a later release.
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
   - `GET /api/admin/gmail` lists connected mailboxes.
   - `DELETE /api/admin/gmail/{id}` disconnects one: it deletes saasmail's
     stored row, including the encrypted refresh token, so saasmail can no
     longer reach the mailbox. It does **not** revoke the grant at Google —
     saasmail makes no revocation call. The refresh token stays valid on
     Google's side until the mailbox owner removes it by hand, under their
     Google Account's third-party access settings
     (<https://myaccount.google.com/connections>). Revoke it there too if the
     disconnect is a response to a compromise, or if the mailbox is leaving
     for good.

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
the Gmail API to read.

The workaround is a "collector" account: a real Workspace user subscribed as a
member of each Group you need. Group mail delivered to members lands in that
collector's own mailbox, which the API can read normally. Mapping a connected
Gmail mailbox to a specific saasmail inbox is not part of this release, so set
this up in anticipation of that — connecting the collector account today
doesn't yet route its mail anywhere.

## Rotating `TOKEN_ENCRYPTION_KEY`

Never rotate `TOKEN_ENCRYPTION_KEY` without reconnecting every mailbox first.
Every stored refresh token is sealed with this key, and changing it makes
those tokens permanently undecryptable — there is no recovery path other than
disconnecting and reconnecting each mailbox from scratch.

---

**See also:** [Configuration](configuration.md) for where the secrets live
