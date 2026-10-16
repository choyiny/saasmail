[saasmail](../README.md) › [Docs](README.md) › **Outlook integration**

# Outlook integration

Connect a Microsoft mailbox — Microsoft 365 (work or school) or a personal
outlook.com / hotmail.com account — and saasmail reads its mail, imports its
last year, and sends replies from it, over Microsoft Graph.

It is the same feature as the [Gmail integration](gmail.md), built the same
way: a cron sync for live mail, a one-off import job for history, inboxes
mapped to the mailbox, and replies sent through the mailbox itself. This page
covers what is specific to Microsoft; the Gmail page explains the shared
behaviour in more depth.

## Setup

### 1. Register an app in Microsoft Entra

In the [Microsoft Entra admin center](https://entra.microsoft.com) →
**App registrations** → **New registration**:

- **Supported account types**: _Accounts in any organizational directory and
  personal Microsoft accounts_ — or a narrower choice if you only want your
  own organization (then set the tenant below to match).
- **Redirect URI**: platform **Web**, and the URI saasmail shows under
  **Microsoft settings** — `<BASE_URL>/api/admin/outlook/callback`. It must
  match character for character, like Google's.

Then:

- **Certificates & secrets** → **New client secret**. Copy the _value_ (not
  the secret ID); Microsoft shows it once.
- **API permissions**: saasmail asks for these delegated Microsoft Graph
  permissions at sign-in, so nothing has to be added here — but a tenant
  that requires admin consent for them needs an admin to grant it:
  `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`.

### 2. Enter it in saasmail

`TOKEN_ENCRYPTION_KEY` must be set (see [Gmail setup](gmail.md#setup) — the
same key serves both providers). Then open **Inboxes → Connected Microsoft
mailboxes → Microsoft settings** and paste the **Application (client) ID** and
the client secret.

**Tenant** is optional. Blank signs in through Microsoft's `common` endpoint,
which accepts any work, school or personal account. A directory ID or domain
(`contoso.onmicrosoft.com`) limits sign-in to that organization.

### 3. Connect and map

**Connect a Microsoft mailbox** opens Microsoft's account picker. After
consent the mailbox is listed with its sync status, and an inbox is pointed
at it from the **Source** column of the inbox table, under **Microsoft**.

A mapping is verified before it is saved: the address must be the mailbox's
own, or one of its aliases (Microsoft 365 lists them as `proxyAddresses`).
A personal account has no aliases saasmail can see, so only its own address
maps. Several inboxes can share one mailbox, routed by `To:`/`Cc:` exactly as
[with Gmail](gmail.md#several-inboxes-on-one-mailbox).

## What syncs

- **Live mail** is read on the same 15-minute cron as Gmail, 50 messages per
  mailbox per tick, from two folders: **Inbox** (onto timelines) and **Sent
  Items** (mirrored as sent mail, so replies typed in Outlook appear too).
  Each folder has its own Graph delta cursor, saved after every page and
  mid-page when the budget runs out.
- Mail a rule files straight into another folder, without passing through the
  Inbox, is not seen live. The import (below) does cover every folder.
- **No sync gaps.** A first sync starts at the moment of connection. If Graph
  expires a delta cursor — after a long outage, say — the sync starts a fresh
  round from five minutes before the last successful sync rather than from
  now, and what it re-reads is deduped. Reconnecting keeps the cursors for
  the same reason. (Gmail cannot do this; see
  [Sync gaps](gmail.md#sync-gaps).)

## The one-year import

The same import as Gmail's — see [The one-year import](gmail.md#the-one-year-import):
the last 365 days, newest first, quiet, with a progress bar on the mailbox
row, running as the `GMAIL_BACKFILL` Workflow (the binding name predates
Outlook). **One import runs at a time across Gmail and Outlook together**; the
others wait their turn.

It reads every folder except **Junk Email**, **Deleted Items** and **Drafts**.
Messages in **Sent Items** are mirrored as sent mail; everything else —
Inbox, Archive, your own folders — is inbound.

## Replies

A reply from an Outlook-mapped inbox is sent with Graph's `sendMail` as MIME,
so it leaves from the mailbox itself, signed by Microsoft, lands in its Sent
Items, and threads in Outlook by its `In-Reply-To`. Like Gmail replies it is
sent directly and never queued for the configured provider: a failure is
reported and the draft kept, and a mailbox whose grant is dead refuses the
reply rather than rerouting it.

Graph returns no id for a sent message. saasmail recognises its own reply when
the Sent Items copy comes back through the sync by the `Message-ID` it wrote,
so a reply appears once.

**Attachments are limited to about 2.25 MB per reply**: Graph caps a
request at 4 MB, and the message is base64-encoded twice on the way.

## Troubleshooting

| `lastError`                    | Meaning                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `invalid_grant`                | The refresh token was revoked or expired. **Reconnect**.            |
| `no_personal_inbox`            | No inbox is mapped to the mailbox, so nothing is read yet. Map one. |
| `message_failed:<id>`          | One message failed; the sync stays on it and retries every tick.    |
| `sync_failed:http_401` / `403` | Graph refused the token. **Reconnect**.                             |
| `sync_failed:…` (other)        | Graph was unreachable or rate-limited; the next tick retries.       |

Microsoft rotates refresh tokens: each refresh can return a new one, which
saasmail stores. Restoring an old database backup can therefore leave a
mailbox holding a spent token — reconnect it.

---

**See also:** [Gmail integration](gmail.md) · [Configuration](configuration.md) · [Inboxes and timelines](inboxes.md)
