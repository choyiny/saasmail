# Email Sequencing Feature — Design Spec

## Overview

A sequencing system that enrolls existing senders (contacts) into a series of timed email templates. Sequences are reusable blueprints with per-sender overrides at enrollment time. Any email exchange (inbound or outbound) between the cmail user and the sender automatically cancels the sequence. Emails are scheduled to the hour, processed by a Cloudflare Workers cron job, and throttled through a Cloudflare Queue.

## Data Model

### `sequences` table

Reusable sequence blueprints.

| Column    | Type          | Notes                                          |
| --------- | ------------- | ---------------------------------------------- |
| id        | text (nanoid) | PK                                             |
| name      | text          | e.g., "Welcome Sequence"                       |
| steps     | text (JSON)   | Array of `{ order, templateSlug, delayHours }` |
| createdAt | timestamp     |                                                |
| updatedAt | timestamp     |                                                |

`steps` example:

```json
[
  { "order": 1, "templateSlug": "intro", "delayHours": 0 },
  { "order": 2, "templateSlug": "follow-up", "delayHours": 24 },
  { "order": 3, "templateSlug": "final-nudge", "delayHours": 168 }
]
```

### `sequence_enrollments` table

Tracks a sender being enrolled in a sequence.

| Column      | Type          | Notes                                   |
| ----------- | ------------- | --------------------------------------- |
| id          | text (nanoid) | PK                                      |
| sequenceId  | text          | FK → sequences                          |
| senderId    | text          | FK → senders                            |
| status      | text          | `active`, `completed`, `cancelled`      |
| variables   | text (JSON)   | Custom variables provided at enrollment |
| enrolledAt  | timestamp     |                                         |
| cancelledAt | timestamp     | nullable                                |

### `sequence_emails` table (the outbox)

One row per step per enrollment — the actual send schedule.

| Column       | Type          | Notes                                              |
| ------------ | ------------- | -------------------------------------------------- |
| id           | text (nanoid) | PK                                                 |
| enrollmentId | text          | FK → sequence_enrollments                          |
| stepOrder    | integer       | Which step                                         |
| templateSlug | text          | Template to send                                   |
| scheduledAt  | timestamp     | Snapped to the hour                                |
| status       | text          | `pending`, `queued`, `sent`, `cancelled`, `failed` |
| sentAt       | timestamp     | nullable                                           |
| sentEmailId  | text          | FK → sent_emails, nullable                         |

### Indexes

- `sequence_emails(status, scheduledAt)` — cron query: find pending emails due now
- `sequence_enrollments(senderId, status)` — cancellation check: is this sender in an active sequence?

## Enrollment Flow

1. User navigates to a sender's view and clicks "Add to Sequence."
2. UI shows a modal with:
   - Dropdown to pick a sequence blueprint
   - Preview of the steps (template name + scheduled time)
   - Ability to skip steps or adjust delays per-sender
   - Form fields for custom variables (e.g., `{{company}}`, `{{meetingLink}}`)
3. On submit, the API:
   - Creates a `sequence_enrollment` row with status `active` and the custom variables
   - Pre-computes all `scheduled_at` timestamps from enrollment time + each step's `delayHours`, snapped to the nearest hour
   - Creates one `sequence_emails` row per step (minus any skipped steps) with status `pending`
   - Returns the enrollment with its scheduled emails

### Snapping to the hour

If enrollment happens at 2:37 PM and step 1 has `delayHours: 0`, it gets scheduled for 3:00 PM (next hour). Step 2 with `delayHours: 24` gets scheduled for the next day at 3:00 PM.

### Validation

- Cannot enroll a sender who is already in an active sequence (prevent duplicates)
- All referenced template slugs must exist
- At least one step must remain after skipping

## Cron Job + Queue Processing

### Cron trigger

Runs every hour (`0 * * * *`) via Cloudflare Workers scheduled handler.

### Cron job logic

1. Query `sequence_emails` where `status = 'pending' AND scheduledAt <= now()`
2. For each batch, push messages onto a Cloudflare Queue with the `sequence_email.id`
3. Update those rows to `status = 'queued'` so they aren't picked up again

### Queue consumer logic

Each message processes one sequence email:

1. Fetch the `sequence_email` row — bail if not `queued` (already cancelled/sent)
2. Fetch the enrollment — bail if not `active`
3. Fetch the template by slug
4. Fetch the sender record for auto-populated variables (`{{name}}`, `{{email}}`)
5. Merge sender variables + enrollment custom variables (custom overrides sender)
6. Interpolate the template subject + body
7. Call Resend API to send
8. On success:
   - Insert a `sent_emails` record
   - Update `sequence_email` to `status = 'sent'`, set `sentAt` and `sentEmailId`
   - If this was the last step, update enrollment to `status = 'completed'`
9. On failure:
   - Update `sequence_email` to `status = 'failed'`
   - CF Queue handles retries automatically (default 3 retries with backoff)

### Queue configuration (wrangler.jsonc)

```jsonc
{
  "queues": {
    "producers": [
      { "binding": "EMAIL_QUEUE", "queue": "cmail-sequence-emails" },
    ],
    "consumers": [
      {
        "queue": "cmail-sequence-emails",
        "max_batch_size": 10,
        "max_retries": 3,
      },
    ],
  },
}
```

## Cancellation

Any email exchange between the cmail user and the sender cancels the sequence.

### Inbound email (recipient replies)

In the existing `email-handler.ts`, after inserting the email, check if the sender has an active enrollment via `sequence_enrollments(senderId, status = 'active')`. If found:

- Set enrollment `status = 'cancelled'`, `cancelledAt = now()`
- Bulk update all `sequence_emails` for that enrollment where `status IN ('pending', 'queued')` to `status = 'cancelled'`

### Outbound email (cmail user manually replies)

In the existing send router (`/api/send` and `/api/send/reply`), after recording the sent email, check if the recipient maps to a sender with an active enrollment. Same cancellation logic as above.

### Race condition with queued emails

A sequence email could already be `queued` and in-flight on the queue when cancellation happens. The queue consumer already checks enrollment status before sending, so it will bail if the enrollment is `cancelled`. This is a safe no-op — no double-send risk.

## API Routes

All routes protected by existing auth middleware.

### Sequences CRUD

| Method | Path                 | Description                            |
| ------ | -------------------- | -------------------------------------- |
| GET    | `/api/sequences`     | List all sequences                     |
| POST   | `/api/sequences`     | Create a sequence (name + steps)       |
| GET    | `/api/sequences/:id` | Get sequence with steps                |
| PUT    | `/api/sequences/:id` | Update sequence (name/steps)           |
| DELETE | `/api/sequences/:id` | Delete (only if no active enrollments) |

### Enrollments

| Method | Path                             | Description                                           |
| ------ | -------------------------------- | ----------------------------------------------------- |
| POST   | `/api/sequences/:id/enroll`      | Enroll a sender (senderId, variables, step overrides) |
| GET    | `/api/senders/:id/enrollment`    | Get active enrollment + scheduled emails for a sender |
| DELETE | `/api/sequence-enrollments/:id`  | Manually cancel an enrollment                         |
| GET    | `/api/sequences/:id/enrollments` | List all enrollments for a sequence                   |

## UI

### 1. Sender Detail — "Add to Sequence" button

- On the sender/conversation view, add an "Add to Sequence" button
- If the sender is already in an active sequence, show sequence status instead (which sequence, current step, next scheduled email) with a "Cancel Sequence" button
- Clicking "Add to Sequence" opens the enrollment modal:
  - Sequence picker dropdown
  - Step preview with skip/delay overrides
  - Variable input fields

### 2. Sequences Management Page

- New page at `/sequences` in the sidebar navigation
- List view of all sequence blueprints: name, step count, active enrollment count
- Create/edit form: name + ordered list of steps (pick template from dropdown, set delay in hours)
- Reorder steps via drag or up/down buttons
- Delete sequence (disabled if active enrollments exist)

### 3. Sequence Detail / Enrollments View

- Click into a sequence to see all enrollments
- Table: sender name/email, status (active/completed/cancelled), enrolled date, progress (e.g., "2/3 sent")
- Click into an enrollment to see the full timeline of scheduled/sent/cancelled emails

## Template Variables

Variables are resolved at send time by merging two sources:

1. **Sender auto-variables**: `{{name}}`, `{{email}}` — populated from the `senders` table
2. **Custom enrollment variables**: arbitrary key-value pairs provided at enrollment time

Custom variables override sender variables if keys collide. The existing `interpolate()` function handles the substitution.
