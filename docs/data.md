[saasmail](../README.md) › [Docs](README.md) › **Export, import and backups**

# Export, import and backups

Your mail is yours to take elsewhere. saasmail exports an inbox as one mbox
file, the format Thunderbird, Apple Mail, Gmail and most mail servers import,
and any single message as an `.eml` file.

## Export a mailbox

**Settings → Data → Export mailbox.** Pick an inbox you can read, optionally a
date range, and whether to include Trash and campaign sends, then **Export**.
Admins also find an **Export** button (the download icon) on each row of the
Inboxes page, which opens the same form with that inbox chosen.

- **What's in it:** the inbox's received and sent mail, oldest first, in every
  folder (Inbox, Archive, Junk, custom folders). Trash and campaign sends are
  left out unless you tick them: a newsletter to 10,000 people would be 10,000
  near-identical messages. Snoozed mail is included.
- **How each message is written:** exactly as it arrived or was sent when
  saasmail kept the original (received mail since migration 0068, and mail
  sent from a JMAP client). Older received mail and mail sent from the web
  app, the API, MCP, sequences and campaigns is rebuilt from what was stored:
  its headers, text and HTML bodies and attachments. A rebuilt message carries
  `X-Saasmail-Reconstructed: yes`.
- **saasmail's own state** goes in headers other mail programs ignore, so a
  later import into saasmail can restore it:

  | Header                    | Value                                                                                                                                                                               |
  | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `X-Saasmail-Labels`       | Like Gmail's `X-Gmail-Labels`: `Inbox`, `Sent`, `Junk` or `Trash` (none for archived mail), then `Starred` and the custom folders, comma-separated (a name with a comma is quoted). |
  | `X-Saasmail-Seen`         | `yes` or `no`, for received mail.                                                                                                                                                   |
  | `X-Saasmail-Person`       | The customer's person id.                                                                                                                                                           |
  | `X-Saasmail-Conversation` | The conversation key snooze and assignment use.                                                                                                                                     |

  Starred and seen are yours, the person who asked for the export.

- **The format** is `mboxrd`: each message starts with a `From <sender> <date>`
  line, line endings are LF, and a body line that starts with `From ` (after
  any number of `>`) gets one more `>`. Readers that understand mboxrd undo
  that quoting.

The export runs in the background, a slice of up to 200 messages at a time, so
any size works. The form's list shows its progress; when it is done you get a
notice in the open app and, if you turned on notifications, a push
notification. **Download** gets the file. It is kept for 7 days, then deleted
(the list then says **Expired**). **Cancel** stops a running export;
**Delete** removes a finished one and its file.

One export of an inbox runs at a time. Only the person who asked for an export
can see and download it, and only while they can still read the inbox. Admins
see and can download every export.

### API

All routes take a session or an `sk_…` API key and follow inbox permissions.

| Route                            | What it does                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/exports`              | `{ inbox, from?, to?, includeTrash?, includeCampaignSends? }` (`from` and `to` are Unix seconds, inclusive). `202` with the export; `403` for an inbox you can't read; `409 EXPORT_RUNNING`. |
| `GET /api/exports`               | Your exports, newest first (the last 50); every export for an admin.                                                                                                                         |
| `GET /api/exports/{id}`          | One export: `status` (`running`, `completed`, `failed`, `expired`), `processedMessages`, `bytes`, `expiresAt`, `error`.                                                                      |
| `GET /api/exports/{id}/download` | The file, `application/mbox`, named `<inbox>-<date>.mbox`. `409 EXPORT_NOT_READY` while it runs, `410 EXPIRED` after 7 days.                                                                 |
| `DELETE /api/exports/{id}`       | Cancels a running export, or deletes a finished one and its file.                                                                                                                            |

Someone else's export answers `404`. Starting, finishing and downloading an
export are recorded in the [audit log](audit-log.md) (`export.started`,
`export.completed`, `export.downloaded`).

### How it runs

The export is an `async_jobs` row (`job_type = 'mail_export'`) worked through
in slices on `EMAIL_QUEUE`, one slice per queue batch. Each slice renders up
to 200 messages (or about 8 MiB, or 20 seconds' worth) and streams them into
one R2 multipart upload in 5 MiB parts, uploading each part as it fills; the
bytes short of a part wait in R2 for the next slice. A slice holds one message
and one part in memory at a time. A slice that fails is retried, three times
in all, and then the export is marked failed and its upload aborted. A
delivery of a slice the export has already passed does nothing, and two
deliveries of the same slice cannot both run, so a queue retry never writes a
message twice.

The hourly cron deletes files older than 7 days, and queues again an export
that has not moved for 15 minutes (its queue message was lost, or a slice
crashed); the fourth time that happens, the export fails. On a `DEMO_MODE`
deployment, which has no queue consumer, the slices run in the background of
the request that started the export, and the hourly cron finishes one that
outlived it.

The file is stored at `exports/<id>/<inbox>.mbox` in the `R2` bucket.

## Download one message

**Download (.eml)** in the reading pane (and **.eml** under a message in a
customer's timeline) saves one message as an RFC 5322 file, the same bytes the
export writes for it, without the `X-Saasmail-*` state headers.
`GET /api/messages/{received|sent}/{id}/raw.eml` does the same over the API;
a rebuilt message also answers with an `X-Saasmail-Reconstructed: yes`
response header.
