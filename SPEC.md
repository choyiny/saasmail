# Spec: Newsletter Module

## Objective

Add newsletter/list-management capabilities to saasmail so operators can:

1. Manage **subscriber lists** (create lists, add/remove members, CSV import/export)
2. Collect subscribers via an **embeddable subscribe form** with optional double opt-in
3. Let recipients **unsubscribe per list** (not just globally) via a one-click link
4. Send **broadcast campaigns** (draft → schedule or send-now → delivered) with open/click tracking

**Target users:** saasmail admins who use the tool for both transactional email and marketing sends and currently have no built-in list or broadcast capability.

**Success looks like:** An admin can create a list, embed a signup form, import existing contacts, draft a campaign from an existing template, schedule it, and see delivery + engagement stats — all without leaving saasmail.

**Prerequisite:** PR #95 (suppression list + `sendWithSuppressionCheck` + HMAC unsubscribe tokens) must be merged before any work here begins. This spec assumes it is already merged.

---

## Tech Stack

No new dependencies unless unavoidable.

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers + Hono + `@hono/zod-openapi` |
| Database | Cloudflare D1 (SQLite via Drizzle ORM) |
| Queue | Cloudflare Queues (campaign fan-out) |
| Cron | Cloudflare Cron Trigger — hourly, already wired |
| Frontend | React 18 + Tailwind CSS + Radix Dialog (existing stack) |
| Testing | Vitest (unit + integration), Playwright (e2e) |
| ORM | Drizzle ORM — schema-first, migrations via `drizzle-kit` |

---

## Commands

```bash
# Development
yarn dev                          # Vite frontend dev server
yarn worker:dev                   # Wrangler dev (backend)

# Build
yarn build                        # Vite frontend build
yarn build:worker                 # Wrangler build

# Type-check (run before every commit)
yarn tsc --noEmit

# Tests
yarn test                         # Vitest unit + integration
yarn test:e2e                     # Playwright e2e

# Database
yarn db:generate                  # drizzle-kit generate (after schema change)
yarn db:migrate:local             # apply migrations locally
yarn db:seed:dev                  # seed dev database

# Secrets
wrangler secret put UNSUBSCRIBE_SECRET   # already required by PR #95
```

---

## Project Structure

New files are marked with `(new)`. Existing files that will be modified are marked `(modified)`.

```
worker/src/
  db/
    lists.schema.ts                (new)  — lists table
    list-members.schema.ts         (new)  — list_members table
    subscribe-forms.schema.ts      (new)  — subscribe_forms table
    campaigns.schema.ts            (new)  — campaigns table
    campaign-events.schema.ts      (new)  — campaign_events (opens + clicks)
    campaign-recipients.schema.ts  (new)  — campaign_recipients (delivery ledger)
    schema.ts                      (modified) — re-export new tables
  lib/
    subscribe-token.ts             (new)  — HMAC tokens for double opt-in confirm
    campaign-sender.ts             (new)  — fan-out logic: enqueue per-member sends
    track-token.ts                 (new)  — HMAC tokens for open/click tracking
    send.ts                        (modified) — extend sendWithSuppressionCheck to
                                              inject tracking pixels + rewrite links
    unsubscribe-token.ts           (modified) — add list_id to v2 token payload
  routers/
    lists-router.ts                (new)  — CRUD lists + member management
    subscribe-forms-router.ts      (new)  — CRUD subscribe forms
    campaigns-router.ts            (new)  — CRUD campaigns + send/schedule
    public-subscribe-router.ts     (new)  — public POST /subscribe/:form_id (no auth)
    public-track-router.ts         (new)  — public GET /track/open/:t /track/click/:t
    unsubscribe-router.ts          (modified) — handle per-list unsubscribe in v2 tokens
  index.ts                         (modified) — mount new routers

src/
  pages/
    ListsPage.tsx                  (new)
    ListDetailPage.tsx             (new)
    CampaignsPage.tsx              (new)
    CampaignDetailPage.tsx         (new)
    SubscribeFormsPage.tsx         (new)
    SubscribeFormBuilderPage.tsx   (new)
  components/
    CampaignStatsCard.tsx          (new)
    ListMembersTable.tsx           (new)
    FormSnippet.tsx                (new)   — copy-paste embed code
  lib/
    api.ts                         (modified) — add fetch helpers for new routes

migrations/
  0027_newsletter_lists.sql        (new)  — lists + list_members
  0028_newsletter_forms.sql        (new)  — subscribe_forms
  0029_newsletter_campaigns.sql    (new)  — campaigns + campaign_events + campaign_recipients + sent_emails(campaignId)
```

---

## Database Schema

### `lists`
```ts
{
  id: text primaryKey,
  name: text notNull,
  description: text,
  fromAddress: text notNull,          // sender identity (FK to sender_identities)
  doubleOptIn: integer notNull default 0,
  confirmationTemplateSlug: text,     // template used for opt-in confirmation email
  createdAt: integer notNull,
  updatedAt: integer notNull,
}
```

### `list_members`
```ts
{
  id: text primaryKey,
  listId: text notNull,               // FK lists.id
  personId: text notNull,             // FK people.id
  email: text notNull,                // denormalized for fast suppression lookup
  status: text notNull default 'pending',  // pending | subscribed | unsubscribed
  source: text notNull,               // form | api | import
  formId: text,                       // FK subscribe_forms.id — null if source != 'form'
  submittedIp: text,                  // IP at form submission time (rate-limit audit)
  subscribedAt: integer,
  confirmedAt: integer,               // double opt-in confirmation timestamp
  unsubscribedAt: integer,
  createdAt: integer notNull,
  // unique(listId, personId)
}
```

### `subscribe_forms`
```ts
{
  id: text primaryKey,
  listId: text notNull,               // FK lists.id
  name: text notNull,
  showNameField: integer notNull default 1,
  nameRequired: integer notNull default 0,
  successMessage: text notNull default 'Thanks for subscribing!',
  redirectUrl: text,                  // optional redirect after submit
  allowedOrigins: text,               // optional comma-separated origins; if set, rejects others
  createdAt: integer notNull,
  updatedAt: integer notNull,
}
```

### `campaigns`
```ts
{
  id: text primaryKey,
  name: text notNull,
  subject: text notNull,
  templateSlug: text notNull,         // FK email_templates.slug
  fromAddress: text notNull,
  listId: text notNull,               // FK lists.id
  status: text notNull default 'draft',  // draft | scheduled | sending | sent | cancelled | stalled
  scheduledAt: integer,               // unix epoch; null = send immediately on trigger
  sentAt: integer,
  statsTotal: integer notNull default 0,
  statsDelivered: integer notNull default 0,
  statsSuppressed: integer notNull default 0,
  statsFailed: integer notNull default 0,
  statsOpens: integer notNull default 0,       // unique opens (best-effort)
  statsClicks: integer notNull default 0,      // unique clicks (best-effort)
  statsUnsubscribes: integer notNull default 0, // per-campaign unsubscribes (v2 token)
  createdAt: integer notNull,
  updatedAt: integer notNull,
}
```

### `campaign_events`
```ts
{
  id: text primaryKey,
  campaignId: text notNull,
  personId: text notNull,
  email: text notNull,
  eventType: text notNull,            // open | click
  url: text,                          // null for opens, original URL for clicks
  occurredAt: integer notNull,
  // unique(campaignId, personId, eventType, url) — dedup at DB level
}
```

### `campaign_recipients`
Per-recipient delivery ledger. Enables accurate stalled-retry targeting and provides an auditable record of who was sent (or skipped) independently of engagement events.

```ts
{
  id: text primaryKey,
  campaignId: text notNull,           // FK campaigns.id
  personId: text notNull,             // FK people.id
  email: text notNull,
  status: text notNull default 'queued',  // queued | sent | suppressed | failed
  sentEmailId: text,                  // FK sent_emails.id — null until transport succeeds
  queuedAt: integer notNull,
  processedAt: integer,
  // unique(campaignId, personId)
}
```

### `sent_emails` extension
The existing `sent_emails` table gains one nullable column in migration `0029`:

```ts
  campaignId: text,   // FK campaigns.id — null for non-campaign sends
```

This ensures every campaign send appears in the person's existing email timeline with no new query logic, preserving saasmail's person-first product promise.

---

## Feature Specifications

### 1. Contact List Management

**API — authenticated (admin + member scoped to allowed inboxes):**

| Method | Path | Description |
|---|---|---|
| GET | `/api/lists` | List all lists (paginated) |
| POST | `/api/lists` | Create list |
| GET | `/api/lists/:id` | Get list detail + member stats |
| PATCH | `/api/lists/:id` | Update list settings |
| DELETE | `/api/lists/:id` | Delete list (cascades members) |
| GET | `/api/lists/:id/members` | List members (paginated, filterable by status) |
| POST | `/api/lists/:id/members` | Add single member (email + name) |
| DELETE | `/api/lists/:id/members/:memberId` | Remove member |
| POST | `/api/lists/:id/members/import` | CSV import (multipart, email+name columns) |
| GET | `/api/lists/:id/members/export` | CSV export (query `?status=subscribed`) |

**CSV import rules:**
- Required column: `email`; optional: `name`
- Skip rows with invalid email format; report `{ imported, skipped }` in response
- Bypasses double opt-in — imported members land as `subscribed`
- Upsert: if person already exists in list, update name if provided but do not change status

**Acceptance criteria:**
- [ ] Admin can create, rename, and delete a list
- [ ] Admin can add a person by email (creates `people` row if not exists)
- [ ] Importing a 1,000-row CSV completes without timeout
- [ ] Export returns correct CSV for the requested status filter
- [ ] Deleting a list with active campaigns returns 409 Conflict

---

### 2. Subscribe Forms

**API — admin only:**

| Method | Path | Description |
|---|---|---|
| GET | `/api/subscribe-forms` | List forms |
| POST | `/api/subscribe-forms` | Create form |
| GET | `/api/subscribe-forms/:id` | Get form + embed snippet |
| PATCH | `/api/subscribe-forms/:id` | Update form settings |
| DELETE | `/api/subscribe-forms/:id` | Delete form |

**Public endpoint (no auth):**

| Method | Path | Description |
|---|---|---|
| POST | `/subscribe/:form_id` | Submit subscription |
| GET | `/subscribe/confirm/:token` | Confirm double opt-in |

**Subscribe flow (double opt-in enabled):**
1. Public `POST /subscribe/:form_id` → validate email + name → upsert `people` row → insert `list_members` with `status: pending` → send confirmation email (uses `confirmationTemplateSlug`) with HMAC-signed confirm token (payload includes `exp: now + 48h`) → return 200 `{ status: "pending" }`
2. Recipient clicks link → `GET /subscribe/confirm/:token` → verify HMAC and check `exp` (return 410 Gone if expired so the subscriber knows to re-subscribe) → set `list_members.status = 'subscribed'` → redirect to `redirectUrl` or show success page

**Subscribe flow (single opt-in):**
1. `POST /subscribe/:form_id` → upsert `people` → insert `list_members` with `status: subscribed` → return 200 `{ status: "subscribed" }`

**Embed snippet:**
The admin UI generates a copy-paste HTML snippet:
```html
<form action="https://your-saasmail.workers.dev/subscribe/FORM_ID" method="POST">
  <input type="email" name="email" required placeholder="your@email.com" />
  <!-- if showNameField -->
  <input type="text" name="name" placeholder="Your name" />
  <button type="submit">Subscribe</button>
</form>
```

**Acceptance criteria:**
- [ ] Submitting a form with double opt-in sends a confirmation email and sets status `pending`
- [ ] Clicking the confirmation link sets status `subscribed`
- [ ] Submitting with an already-subscribed email returns 200 (idempotent)
- [ ] Submitting with an invalid email returns 422
- [ ] Confirmation token replay after use returns 200 (idempotent, not an error)
- [ ] Form embed snippet is displayed in the admin UI with a copy button

**Abuse controls (public endpoint):**
- **Honeypot:** Embed snippet includes a hidden `<input name="_hp" tabindex="-1" style="display:none">` field. Server silently returns 200 if non-empty to avoid leaking bot detection.
- **Confirmation rate limit:** Max 2 confirmation emails per email address per 1-hour window, checked by counting recent `list_members.createdAt` for that email in D1 before sending.
- **Submission rate limit:** Max 10 submissions per IP per 1-hour window, checked via `submittedIp` count in D1.
- **Allowed origins:** If `subscribe_forms.allowedOrigins` is non-null, reject `POST /subscribe/:form_id` with a non-matching `Origin` header (return 403). Null means accept from any origin.
- **Generic errors:** All 403/422 responses from this public endpoint use a generic message; do not reveal which check failed.

---

### 3. Unsubscribe (Per-List)

**Extension of PR #95's HMAC token:**

PR #95 uses `{v:1, email}`. Campaign sends use `{v:2, email, list_id, campaign_id}` (v2 tokens). Including `campaign_id` allows unsubscribes to be attributed to the correct campaign stats counter.

**Unsubscribe handler (extended in `unsubscribe-router.ts`):**
- v1 token (no `list_id`) → writes to global `suppressions` table (existing PR #95 behavior, unchanged)
- v2 token (has `list_id`) → **idempotency check:** if `list_members.status` is already `'unsubscribed'`, return 200 without touching any counter; otherwise sets `list_members.status = 'unsubscribed'`; does **not** write to global `suppressions`; increments `campaigns.statsUnsubscribes` for the `campaign_id` in the token

**`List-Unsubscribe` header on campaign sends:**
The header URL uses a v2 token. The `/unsubscribe` page (from PR #95) handles both versions transparently.

**Acceptance criteria:**
- [ ] Clicking an unsubscribe link from a campaign email sets `list_members.status = 'unsubscribed'`
- [ ] One-click POST from Gmail/Fastmail triggers the same status update (RFC 8058)
- [ ] The unsubscribed member is excluded from all future sends to that list
- [ ] Re-subscribe button on the unsubscribe page sets status back to `subscribed`
- [ ] v1 tokens (from PR #95 transactional sends) still work without change
- [ ] Clicking the unsubscribe link twice does not double-increment `campaigns.statsUnsubscribes`

---

### 4. Campaign Management

**API — authenticated:**

| Method | Path | Description |
|---|---|---|
| GET | `/api/campaigns` | List campaigns (paginated) |
| POST | `/api/campaigns` | Create campaign (draft) |
| GET | `/api/campaigns/:id` | Get campaign detail + stats |
| PATCH | `/api/campaigns/:id` | Update campaign (draft only) |
| DELETE | `/api/campaigns/:id` | Delete campaign (draft only) |
| POST | `/api/campaigns/:id/send` | Trigger immediate send |
| POST | `/api/campaigns/:id/schedule` | Schedule for future datetime |
| POST | `/api/campaigns/:id/cancel` | Cancel scheduled campaign |
| GET | `/api/campaigns/:id/stats/timeseries` | Hourly open + click counts (last 24 h from send) |
| GET | `/api/campaigns/:id/links` | Per-URL click count and click rate |

**Fan-out send mechanism:**
1. `POST /api/campaigns/:id/send` or cron trigger for scheduled campaigns:
   - Set `campaigns.status = 'sending'`
   - Query all `list_members` where `status = 'subscribed'` and `list_id = campaign.list_id`
   - Insert all `campaign_recipients` rows (`status: 'queued'`) in a single **`db.batch([...])`** call — do not insert row-by-row; batch size ≤ 100 statements per D1 batch call to stay within limits
   - Enqueue one Cloudflare Queue message per member: `{ campaign_id, person_id, email }`
   - Set `campaigns.stats_total = member_count`
2. Queue consumer per message:
   - **Idempotency check:** if `campaign_recipients` already has `status = 'sent'` for this `(campaignId, personId)` pair, skip processing and acknowledge the message — prevents duplicate sends on Cloudflare Queue retry
   - Call `sendWithSuppressionCheck` (from PR #95) with `transactional: false`
   - Inject tracking pixel and rewrite links (see below)
   - On success: create a `sent_emails` row with `personId`, `fromAddress`, `subject`, `messageId`, and `campaignId`; set `campaign_recipients.status = 'sent'` and `sentEmailId`; increment `stats_delivered`
   - On suppressed: set `campaign_recipients.status = 'suppressed'`; increment `stats_suppressed`
   - On error: set `campaign_recipients.status = 'failed'`; increment `stats_failed`
   - When `stats_delivered + stats_suppressed + stats_failed == stats_total`: set `status = 'sent'`, `sent_at = now()`
3. Hourly Cron trigger: query campaigns where `status = 'scheduled'` and `scheduled_at <= now()` → trigger fan-out

**Scheduling:** Granularity is the nearest minute; the cron runs hourly but `scheduledAt` stores a precise timestamp. Campaigns with `scheduledAt` in the past but less than 2 hours old are still sent (catch-up window).

**Stalled recovery:** The same hourly cron checks for `status = 'sending'` campaigns with `updated_at < now() - 24h` and marks them `stalled`. The admin UI shows a warning and a Retry button. Retry re-enqueues only recipients whose `campaign_recipients.status IN ('queued', 'failed')` — `sent` and `suppressed` recipients are never re-sent.

**List size cap:** `POST /api/campaigns/:id/send` returns 422 if the target list has >10,000 subscribed members. The same cap is enforced on `POST /api/lists/:id/members/import`.

**Open tracking:**
- Before enqueue, the HTML template is rendered with variables
- A `<img src="{{BASE_URL}}/track/open/TOKEN" width="1" height="1" style="display:none" />` is appended to the HTML body
- `TOKEN` = HMAC-signed `{v:1, campaign_id, person_id}` (same key as `UNSUBSCRIBE_SECRET`)
- `GET /track/open/:token` (public, no auth): verify token → return a base64-encoded 1×1 transparent GIF **immediately** with `Cache-Control: no-store, must-revalidate` and `Pragma: no-cache` headers → upsert `campaign_events` and increment `campaigns.stats_opens` if new via **`ctx.waitUntil()`** so the analytics write never delays the pixel response

**Click tracking:**
- All `<a href>` links in the HTML body are rewritten to `{{BASE_URL}}/track/click/TOKEN` using Cloudflare's native **`HTMLRewriter`** API (streaming, Rust-backed parser) to keep per-subscriber CPU time low; do not use string-replace or a DOM parser
- `TOKEN` = HMAC-signed `{v:1, campaign_id, person_id, url: original_url}`
- `GET /track/click/:token` (public): verify → upsert event (dedup by `unique(campaign_id, person_id, 'click', url)`) → increment `campaigns.stats_clicks` if new → 302 redirect to original URL
- Links with `{{unsubscribe_url}}` are **not** rewritten (preserve unsubscribe flow)

**Tracking accuracy caveat:**
Open and click counts are **best-effort engagement signals, not ground truth:**
- Apple Mail Privacy Protection (MPP) pre-fetches tracking pixels — open counts will overcount significantly for consumer-facing lists.
- Some email clients and corporate proxies pre-fetch links, inflating click counts.
- The pixel endpoint returns `Cache-Control: no-store, must-revalidate` and `Pragma: no-cache` (specified above); this minimises proxy caching but cannot prevent MPP.
- The admin UI labels these as **"~opens"** and **"~clicks"** (approximate) to set operator expectations.

**Campaign stats view (`CampaignDetailPage`):**

The detail page renders three sections (matching the Keila statistics view):

1. **Stats grid** — 6 metric tiles:
   - Sent (`statsTotal`)
   - Opened (`statsOpens`, shown as `~N  X.X%` of total)
   - Clicked (`statsClicks`, shown as `~N  X.X%` of total)
   - Unsubscribed (`statsUnsubscribes`, shown as `N  X.X%` of total)
   - Bounces — displays `—` in v1 (no webhook infrastructure yet)
   - Complaints — displays `—` in v1
2. **24-Hour Performance chart** — line chart with two series (opens, clicks) bucketed by hour. Data from `GET /api/campaigns/:id/stats/timeseries`. If the campaign is still `sending`, the chart refreshes every 30 s.
3. **Links table** — columns: URL, Clicks, Click rate. Data from `GET /api/campaigns/:id/links`, sorted by clicks desc. Empty state shown when no links have been clicked yet.

**`GET /api/campaigns/:id/stats/timeseries` response:**
```json
{ "data": [{ "hour": 1716480000, "opens": 5, "clicks": 2 }] }
```
Returns 24 hourly buckets anchored to send time. Hours with no events are included with zero counts.

**`GET /api/campaigns/:id/links` response:**
```json
{ "data": [{ "url": "https://example.com", "clicks": 12, "clickRate": 0.04 }] }
```
`clickRate = clicks / statsTotal`. Sorted by `clicks` desc.

**Acceptance criteria:**
- [ ] Admin can create a draft campaign, select a list and template, and preview rendered output
- [ ] Sending to a 500-member list enqueues all messages without D1 timeout
- [ ] Each subscriber receives a unique unsubscribe link (v2 HMAC token)
- [ ] Each subscriber receives a unique tracking pixel and unique click-tracking URLs
- [ ] Suppressed addresses are excluded and counted in `stats_suppressed`
- [ ] Opening an email increments `stats_opens` exactly once per person per campaign
- [ ] Clicking a link increments `stats_clicks` exactly once per person per URL per campaign
- [ ] Scheduling a campaign for a future time sends it within the next hourly cron window
- [ ] Editing or deleting a campaign in `sending` or `sent` status returns 409 Conflict
- [ ] Each send creates a `sent_emails` row with `campaignId`; the send appears in the recipient's person timeline
- [ ] The campaign detail page renders the stats grid, 24-hour performance chart, and links table
- [ ] Unsubscribing via a campaign email increments `statsUnsubscribes` for that campaign
- [ ] `GET /api/campaigns/:id/stats/timeseries` returns 24 hourly buckets (zero-filled for empty hours)
- [ ] `GET /api/campaigns/:id/links` returns per-URL click counts sorted by clicks desc

---

## Authorization Matrix

Scoping rule: lists and campaigns are scoped to a `fromAddress` (sender identity). A member with access to the inbox tied to that `fromAddress` can read and write lists and campaigns for that identity. Admins have unrestricted access. Send / schedule / cancel / retry operations are **admin-only** to prevent accidental dispatch.

| Operation | Admin | Member (scoped) | API Key (admin) | API Key (member) | Public |
|---|---|---|---|---|---|
| Create / edit / delete lists | ✅ | ✅ allowed `fromAddress` only | ✅ | ✅ scoped | ❌ |
| Import / export members | ✅ | ✅ scoped | ✅ | ✅ scoped | ❌ |
| View campaign stats | ✅ | ✅ scoped | ✅ | ✅ scoped | ❌ |
| Create / edit campaigns (draft) | ✅ | ✅ scoped | ✅ | ✅ scoped | ❌ |
| Send / schedule / cancel / retry campaigns | ✅ only | ❌ | ✅ only | ❌ | ❌ |
| Create / edit / delete subscribe forms | ✅ | ❌ admin-only | ✅ | ❌ | ❌ |
| Submit subscribe form | ❌ | ❌ | ❌ | ❌ | ✅ |
| Confirm double opt-in | ❌ | ❌ | ❌ | ❌ | ✅ HMAC token |
| Open pixel / click redirect | ❌ | ❌ | ❌ | ❌ | ✅ HMAC token |
| Unsubscribe | ❌ | ❌ | ❌ | ❌ | ✅ HMAC token |

**API key access:** API keys are per-user (existing model). Lists and campaign endpoints honour the key owner's role and inbox permissions exactly as session-based auth does. No new key scope types are required for v1.

---

## Code Style

Follow existing patterns in the codebase exactly.

**Router pattern (Hono + Zod OpenAPI):**
```ts
// worker/src/routers/lists-router.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const listsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ListSchema = z.object({
  id: z.string(),
  name: z.string(),
  fromAddress: z.string(),
  doubleOptIn: z.boolean(),
  createdAt: z.number(),
});

const listListsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Lists"],
  description: "List all subscriber lists.",
  responses: {
    ...json200Response(z.array(ListSchema), "Paginated lists"),
  },
});

listsRouter.openapi(listListsRoute, async (c) => {
  const db = c.get("db");
  // ...
  return c.json({ data, total, page, limit }, 200);
});
```

**Schema pattern (Drizzle):**
```ts
// worker/src/db/lists.schema.ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const lists = sqliteTable("lists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  fromAddress: text("from_address").notNull(),
  doubleOptIn: integer("double_opt_in").notNull().default(0),
  confirmationTemplateSlug: text("confirmation_template_slug"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

**Reserved template variables** (auto-injected on campaign and confirmation sends; blocked as user-defined variable names):
- `{{unsubscribe_url}}` — per-recipient signed unsubscribe link
- `{{subscriber_name}}` — recipient's name from `people.name` (empty string if null)
- `{{subscriber_email}}` — recipient's email address
- `{{confirm_url}}` — double opt-in confirmation link (confirmation emails only)

**Key conventions:**
- IDs: `nanoid()` (already used everywhere)
- Timestamps: Unix epoch integers (not ISO strings)
- JSON columns: `text("col")` with manual `JSON.parse`/`JSON.stringify`
- Route files export a named `*Router` const; mounted in `index.ts`
- All public (no-auth) routes are in dedicated router files, not mixed with authed routes
- Frontend: `useState` + imperative `fetch` (not SWR or React Query) — match existing `AdminUsersPage` pattern
- UI components: Radix Dialog for modals, existing Tailwind color tokens (`bg-bg-muted`, `text-text-secondary`, etc.)

---

## Testing Strategy

**Framework:** Vitest for unit + integration; Playwright for e2e.

**Unit tests** (`worker/src/__tests__/`):
- HMAC token helpers: round-trip, tampered sig, wrong secret, malformed input, expired token (48 h TTL on confirm tokens)
- `campaign-sender.ts`: correct member enumeration, suppressed-member exclusion, `campaign_recipients` rows pre-populated as `queued`
- `track-token.ts`: round-trip, dedup logic

**Integration tests** (`worker/src/__tests__/`):
- Lists CRUD with admin + member auth
- List member add/remove/import/export
- Subscribe form submission (single opt-in + double opt-in full flow)
- Confirmation token: valid, tampered, replayed
- Campaign CRUD, send trigger, schedule/cancel
- Queue consumer: `campaign_recipients` queued → sent/suppressed/failed transitions; `sent_emails.campaignId` populated on success; counter increments
- Open tracking: first open increments counter; replay does not
- Click tracking: redirect, dedup
- Per-list unsubscribe via v2 token: `campaigns.statsUnsubscribes` incremented; re-subscribe
- `GET /api/campaigns/:id/stats/timeseries`: 24 hourly buckets, zero-filled, correct open/click counts
- `GET /api/campaigns/:id/links`: per-URL click counts, click rate calculation, sorted desc

**e2e tests** (`e2e/specs/`):
- `lists.spec.ts` — create list, import CSV, view members
- `campaigns.spec.ts` — draft → send → verify stats
- `subscribe-form.spec.ts` — embed form submit → verify member appears in list

**Coverage requirement:** All new route handlers and lib utilities must have integration tests. No new router file ships without tests.

---

## Boundaries

**Always:**
- Run `yarn tsc --noEmit` before committing — zero type errors
- Run `yarn test` before committing — all tests must pass
- Use `nanoid()` for new IDs
- Use `sendWithSuppressionCheck` (from PR #95) for every send — never call the transport directly
- Set `transactional: false` on campaign sends so `List-Unsubscribe` headers are injected by PR #95
- Dedup tracking events at the DB level (unique constraint) not just in application logic
- Create a `sent_emails` row (with `campaignId`) for every successful campaign send — campaigns must appear in the person timeline
- Return 409 Conflict when modifying a campaign in `sending` or `sent` status

**Ask first:**
- Adding any new npm/yarn dependency
- Changing the D1 schema in a way that requires a non-trivial migration (column drops, renames)
- Adding open tracking or click tracking to non-campaign sends (transactional)
- Changing the HMAC token format for existing v1 tokens (must remain backward compatible)
- Adding per-inbox RBAC to campaigns (deferred to v2)
- Bounce/complaint webhook integration to auto-update `list_members.status` (deferred to v2; target behaviour: hard bounce → `unsubscribed` + global suppression, complaint → global suppression)
- Preference center UI on the unsubscribe page (deferred to v2)
- `mailto:` form in `List-Unsubscribe` header (deferred to v2 per PR #95)

**Never:**
- Commit `UNSUBSCRIBE_SECRET` or any secret to the repo
- Skip the suppression check on campaign sends
- Allow campaign sends to proceed if status is already `sending` or `sent` (prevent double-send)
- Skip rate-limit or honeypot checks on the public subscribe endpoint
- Serve tracking pixels or redirect endpoints behind auth (they must be public)
- Rewrite `{{unsubscribe_url}}` links during click-tracking link rewriting
- Drop or rename existing columns in migrations (add only; use Drizzle addColumn pattern)

---

## Implementation Order

Dependencies flow top to bottom. Do not begin a phase until the previous phase's tests are green.

```
Phase 1 — Foundation (no UI yet)
  └── DB schemas + migrations (lists, list_members, subscribe_forms, campaigns, campaign_events, campaign_recipients, sent_emails.campaignId)
  └── lib/subscribe-token.ts
  └── lib/track-token.ts
  └── Extend lib/unsubscribe-token.ts for v2 (list_id)
  └── Unit tests for all three token libs

Phase 2 — List Management
  └── lists-router.ts (CRUD + member endpoints + CSV import/export)
  └── Integration tests

Phase 3 — Subscribe Forms
  └── subscribe-forms-router.ts (admin CRUD)
  └── public-subscribe-router.ts (POST /subscribe/:form_id, GET /subscribe/confirm/:token)
  └── Integration tests (single opt-in + double opt-in flows)

Phase 4 — Campaigns
  └── campaigns-router.ts (CRUD + send + schedule + cancel)
  └── campaign-sender.ts (fan-out queue enqueue logic)
  └── Extend queue consumer in index.ts for campaign messages
  └── Extend lib/send.ts for tracking pixel injection + link rewriting
  └── public-track-router.ts (open pixel + click redirect)
  └── campaigns-router.ts: add /stats/timeseries and /links sub-routes
  └── Integration + unit tests
  └── Extend unsubscribe-router.ts for v2 token → list_members update + statsUnsubscribes increment

Phase 5 — Frontend
  └── ListsPage, ListDetailPage, ListMembersTable
  └── SubscribeFormsPage, SubscribeFormBuilderPage, FormSnippet
  └── CampaignsPage, CampaignDetailPage, CampaignStatsCard
  └── Nav links in existing sidebar
  └── PersonDetail: add "List memberships" section (list name + status per list the person belongs to)
  └── PersonDetail: campaign sends surface in existing timeline automatically (sent_emails rows
       with campaignId rendered by the existing thread view; add a "campaign" badge to distinguish)
  └── e2e tests
```

---

## Success Criteria

The feature is complete when:

- [ ] All phases above have passing unit + integration tests
- [ ] `yarn tsc --noEmit` is clean
- [ ] An admin can complete this full flow without errors:
  1. Create a list with double opt-in enabled
  2. Create a subscribe form for that list
  3. Submit the public form → receive confirmation email → click confirm → member appears as `subscribed`
  4. Import a CSV of 100 contacts into the same list
  5. Create a campaign targeting that list using an existing template
  6. Schedule the campaign → cancel → reschedule → send immediately
  7. Verify delivery stats, open count, and click count are correct in the UI
  8. Click the unsubscribe link from the campaign email → member status changes to `unsubscribed`
  9. Re-subscribe → member status returns to `subscribed`
  10. Attempt to send the campaign again → receive 409 Conflict

---

## Decisions (resolved)

1. **Max list size:** Hard cap of **10,000 members per list** for v1, enforced at the API layer (return 422 if a send would exceed this). Fits saasmail's SaaS-team philosophy — beyond 10k you are in mass-marketing territory (Mailchimp's domain). Maps to a maximum of 100 Cloudflare Queue batch calls of 100 messages each.

2. **Template variable injection — hybrid approach:** `{{unsubscribe_url}}`, `{{subscriber_name}}`, and `{{subscriber_email}}` are **reserved variables** automatically injected during the per-subscriber render pass alongside any user-defined template variables. This means template authors can place `{{unsubscribe_url}}` anywhere in their template body (consistent with the existing `{{variable}}` convention). The tracking pixel (`<img>` tag) is still auto-appended as a post-process after rendering since it should not be manually placed by template authors. Reserved variable names are documented and blocked from being used as user-defined template variables.

3. **Default confirmation template:** Ship a **hardcoded built-in default** confirmation email in the worker code (plain HTML string constant). The list's `confirmationTemplateSlug` field is optional — when set, it overrides the default by rendering the named `email_templates` record instead. This matches Keila's behaviour: a default exists out of the box; admins can optionally customise it per-list. Double opt-in can therefore be enabled on any list without any template setup.

4. **Sent campaigns are immutable:** A campaign's `list_id`, `templateSlug`, `subject`, and `fromAddress` cannot be changed once `status` leaves `draft`. The API returns 409 Conflict on any PATCH to those fields when `status != 'draft'`.

5. **Stalled campaign recovery:** The hourly Cron trigger checks for campaigns where `status = 'sending'` AND `updated_at < now() - 24 hours`. These are marked `status = 'stalled'` (a new terminal status, distinct from `sent`). Stats columns retain their partial values so the operator can see how many were delivered before the stall. The admin UI surfaces `stalled` campaigns with a warning banner and a "Retry" button that re-enqueues only recipients with `campaign_recipients.status IN ('queued', 'failed')`, preventing double-sends. This avoids the silent "stuck forever" bug documented in [Keila issue #464](https://github.com/pentacent/keila/issues/464). The `campaigns` table gains one additional status value: `stalled`.
