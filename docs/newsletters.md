[saasmail](../README.md) › [Docs](README.md) › **Newsletters**

# Newsletters

Lists, subscribe forms, and campaigns — bulk marketing mail, kept deliberately separate from the transactional and sequence paths that share the same worker.

## Contacts are not people

A newsletter subscriber is a `contacts` row, not a `people` row. `people` is the inbox side of saasmail: it drives the conversation list, which is ordered by last contact. Importing ten thousand subscribers into it would bury every real correspondent.

The two are linked, never merged. `contacts.personId` is filled in only when a `people` row for that address **already exists** — a campaign send never creates one, and the hourly pass backfills the link for subscribers who later become correspondents on their own. A campaign send to someone already in your inbox shows up in their timeline; a send to a stranger leaves your contact list exactly as it was.

## Lists and members

| Endpoint                              | Does                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| `GET/POST /api/lists`                 | List and create                                              |
| `PATCH/DELETE /api/lists/{id}`        | Update; delete **archives** once the list has sent campaigns |
| `GET/POST /api/lists/{id}/members`    | Page through members, add one                                |
| `DELETE /api/lists/{id}/members/{id}` | Sets `status = 'unsubscribed'` — never deletes the row       |
| `GET /api/lists/{id}/export`          | Streamed CSV                                                 |
| `POST /api/lists/{id}/import`         | Async CSV import; returns a job id                           |

Two rules hold everywhere:

- **Removing a member is a status change.** The row carries `consentSource`, `consentAt` and (for imports) `importJobId` — it is the answer to "why do we have this address?", and deleting it destroys that answer along with the membership.
- **A list with campaign history is archived, not dropped.** Its delivery records still reference it.

CSV export is formula-injection-safe: a cell starting `=`, `+`, `-` or `@` (including behind leading control characters) is prefixed so a spreadsheet renders it as text instead of executing it.

## Subscribe forms

`POST /subscribe/{formId}` is public and unauthenticated — it is a form on someone else's website. Three controls sit in front of it:

- a **honeypot** field that real users never fill in,
- **rate limiting** backed by `subscribe_attempts`, per form+email and per IP,
- an **origin check** that fails closed when a form declares allowed origins.

`subscribe_attempts` stores a SHA-256 digest of the address, never the address, and is swept hourly after 24 hours.

With **double opt-in** on, a submission creates a `pending` member and mails a confirmation link; `GET /subscribe/confirm/{token}` promotes it to `subscribed`. An expired confirmation answers `410` so the page can offer a fresh signup rather than a dead end.

## Campaigns

**A campaign owns its content.** `bodyHtml` — and `bodyJson` when the campaign
is block-authored — live on the campaign row and are edited on the campaign
page while it is a `draft`.

Picking a template at creation is optional and means _start from this_: the
template's content is **copied in** once, and the campaign owns it from then on.
Editing or deleting that template afterwards cannot reach back into the
campaign. `templateSlug` is kept only as provenance and is never read when
rendering.

That split is what makes templates useful in both places. A newsletter needs its
own words every time, so a campaign that could only point at a template forced
one throwaway template per campaign. Templates keep their original job on the
[transactional and sequence](sequences.md) paths, where a template genuinely is
the content and carries a `{{variable}}` send contract.

A campaign with an empty body is refused at send time rather than mailing a
blank page to a list.

A campaign moves through a small, explicit state machine. Anything not listed is a `409` — a campaign is real mail to real people, so an unspecified transition fails loudly rather than doing something plausible.

| Action             | Allowed from                                            |
| ------------------ | ------------------------------------------------------- |
| edit, delete       | `draft`                                                 |
| send               | `draft`, `scheduled`, `overdue`                         |
| schedule           | `draft`, `scheduled`                                    |
| cancel             | `draft`, `scheduled`, `overdue`, `preparing`, `sending` |
| retry              | `stalled`, `completed_with_failures`                    |
| preview, test-send | `draft`, `scheduled`, `overdue`                         |

**Content is frozen on send.** Leaving `draft` snapshots the subject, HTML, text and from-address. Editing or deleting the source template afterwards cannot change mail that is already going out — otherwise a half-sent campaign delivers two different emails under one name.

**Fan-out is resumable.** The coordinator enqueues one page of recipients at a time and only advances its cursor after both the inserts and the queue publish succeed. A duplicate queue delivery is harmless: each recipient is claimed with a single atomic `UPDATE … RETURNING`, so a second delivery finds nothing to claim and stops.

**A crash between "provider accepted" and "we wrote it down" self-heals.** The outbox row is held in `bookkeeping_pending` rather than deleted, and the hourly pass finishes the bookkeeping. It never re-sends: the retry path only ever looks at `pending` rows.

A campaign that finishes with permanently-rejected recipients ends in `completed_with_failures`, not `sent`. `POST /retry` re-attempts only the recoverable ones.

### Scheduling

A scheduled campaign fires on the next hourly tick. More than 24 hours late it moves to `overdue` instead — visible and re-sendable with one click, rather than silently blasting a list on a schedule everyone has forgotten. Scheduling in the past is refused with `422`; a mistyped date should not send.

## Unsubscribe

Campaign mail carries a **v2** token naming the list, the campaign and the contact: clicking it leaves that list. It is not a global suppression — a reader leaving one newsletter has not withdrawn consent for transactional mail or for your other lists. Legacy **v1** tokens still mean global suppression and still verify, and the `/unsubscribe` page handles both.

The same URL appears in the body, the footer fallback and both `List-Unsubscribe*` headers, including after an outbox retry, so one click means one thing.

Re-subscribing with the undo button works for **7 days** after unsubscribing. Past that the endpoint answers `410` and the way back is a fresh opt-in through the form — a token lives in an email forever, and without a window anyone holding a forwarded copy could re-subscribe an address indefinitely.

## Open and click tracking

Every recipient gets their own pixel and their own opaque redirect URLs. A click token carries a **link id, never a URL**: HMAC protects integrity, not confidentiality, so a URL inside a token is readable by anyone holding the link — and campaign links can themselves carry signed or passwordless parameters.

Four token purposes (subscribe-confirm, unsubscribe, open, click) use four keys derived from `UNSUBSCRIBE_SECRET`, so a token that leaks from one context cannot be replayed against another. That matters most for the pixel, which travels through image caches and proxy logs.

The **text part is not link-rewritten**. Opaque redirect URLs in plain text read as phishing to filters and humans alike, and a text-only reader cannot load a pixel to correlate with anyway.

| Endpoint                                   | Returns                                  |
| ------------------------------------------ | ---------------------------------------- |
| `GET /api/campaigns/{id}`                  | Live stats from the ledgers, not a cache |
| `GET /api/campaigns/{id}/stats/timeseries` | 24 hourly buckets, zero-filled           |
| `GET /api/campaigns/{id}/links`            | Per-URL unique clicks, sorted desc       |

> **Opens and clicks are approximate.** Apple Mail Privacy Protection pre-fetches every tracking pixel, and some corporate proxies pre-fetch links. Both inflate counts. The UI labels them `~opens` and `~clicks` for that reason. Treat them as engagement signals, not ground truth.

A recipient-facing tracking disclosure is not included by default; check what your jurisdiction requires before enabling tracked sends.

## Before you send

`UNSUBSCRIBE_SECRET` must be set on the worker. Every campaign email carries a
signed per-list unsubscribe link, so without it a send is refused with `422`
rather than started — the signing happens after a recipient is claimed, and a
claimed recipient is not re-claimable, so failing late would strand the campaign
in `sending` until the 24-hour stall sweep.

```
wrangler secret put UNSUBSCRIBE_SECRET   # openssl rand -hex 32
```

An instance deployed before the unsubscribe feature existed will not have it.

## Privacy and retention

| Data                       | Window                                            |
| -------------------------- | ------------------------------------------------- |
| `subscribe_attempts`       | 24 hours                                          |
| `list_members.submittedIp` | 30 days, then nulled — the membership row is kept |
| Re-subscribe undo          | 7 days from `unsubscribedAt`                      |
| `campaign_events`          | 13 months                                         |
| Newsletter images          | Kept indefinitely — see below                     |
| Delivery/consent rows      | Kept until the contact is explicitly erased       |

Every sweep is a bounded batch on the hourly cron: one tick removes at most one batch and the next continues, because an unbounded delete over thirteen months of events is the statement that times out and then never succeeds on any later tick either.

**Newsletter images are never garbage-collected.** An image referenced by a
sent campaign has to outlive the template that introduced it — the campaign's
frozen `htmlSnapshot` still points at that URL when a subscriber opens the mail
months later — so reference counting would have to span every historical
snapshot, not just live templates. Assets accumulate; budget R2 accordingly.

Two admin-only operations answer subject requests:

- `GET /api/contacts/{email}/export` — everything the newsletter tables hold for that address.
- `POST /api/contacts/{email}/erase` — replaces the address with a keyed one-way pseudonym across `contacts`, `list_members`, `campaign_events` and `campaign_recipients`, and deletes the attempt digests. The rows themselves stay: they are the evidence that a suppression or a consent actually happened.

The pseudonym is a keyed HMAC rather than a bare digest. Email addresses are low-entropy, so a plain SHA-256 is reversible with a dictionary and would not be erasure at all.

---

**See also:** [Suppressions and unsubscribe](suppressions.md) · [Email templates](templates.md) · [Sequences](sequences.md) · [Configuration](configuration.md)
