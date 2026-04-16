# Inbox Permissions Design

**Date:** 2026-04-16
**Status:** Draft — pending user review

## Problem

Every authenticated user currently sees every inbox. We need to let admins restrict members to specific inboxes so that a member with, say, `jane@foo.com` assigned cannot read or send from `bob@foo.com`. Admins retain full access to everything and are never explicitly assigned.

## Goals

- Admins assign non-admin users ("members") to specific inboxes.
- A member can only read, send from, and otherwise interact with the inboxes they're assigned to. Access is "full" within the scope of those inboxes — read, send, sequences, templates.
- A member with zero inboxes can log in and sees an empty state.
- Admins are implicitly allowed on every inbox — no assignment rows needed.
- The settings page is renamed to `/inboxes` and is the single admin surface for both display-name and permission management.

## Non-goals

- Per-inbox granular permissions (e.g., read-only vs send-only).
- Ownership of sequences/templates by individual creators.
- A member-facing flow to request inbox access.
- An audit log of assignment changes over time.

## Data Model

### New table `inbox_permissions`

```ts
{
  userId:    text (FK → users.id, onDelete: cascade),
  email:     text,                     // inbox address, matches emails.recipient
  createdAt: integer (unix seconds),
  createdBy: text (FK → users.id, onDelete: set null),
  PRIMARY KEY (userId, email),
  INDEX on email
}
```

The `email` column is a free-form string — intentionally not an FK. The universe of assignable inboxes is derived from the union of distinct `emails.recipient` values and `sender_identities.email` rows, so a dedicated `inboxes` table is not added.

### Modified table `email_templates`

Add nullable column `from_address text`. `null` = global/admin-only. Existing rows are left `null`; members cannot create a template without an allowed `from_address`.

### Unchanged

`users`, `emails`, `sent_emails`, `people`, `sequences`, `sequence_enrollments`, `sender_identities` — no changes.

## Permission Resolution

A middleware `injectAllowedInboxes` runs after auth on every `/api/*` route (except auth/setup/invites/health/config). It calls `resolveAllowedInboxes(db, user)` once and stores the result on `c.set("allowedInboxes", …)`.

```ts
type AllowedInboxes = { isAdmin: true } | { isAdmin: false; inboxes: string[] };
```

Helpers used by handlers:

- `assertInboxAllowed(allowed, email)` — throws HTTPException 403 if a member attempts to use an inbox outside their set; short-circuits true for admins.
- `inboxFilter(allowed, column)` — returns a Drizzle condition:
  - Admin → `undefined` (caller composes with `and()` normally).
  - Member with ≥1 inbox → `inArray(column, allowed.inboxes)`.
  - Member with 0 inboxes → ``sql`0` `` (matches nothing). Prevents accidental "empty list = everything" bugs.

Cost: one extra small SELECT per request for members; zero for admins.

## API Changes

### Admin-only, under `/api/admin/inboxes`

| Method  | Path                                    | Purpose                                                                                                                                                             |
| ------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/admin/inboxes`                    | List rich inbox rows `{ email, displayName, assignedUserIds }` — union of `emails.recipient` and `sender_identities` left-joined to `inbox_permissions`.            |
| `PATCH` | `/api/admin/inboxes/:email`             | Body `{ displayName?: string \| null }`. Upserts or clears the `sender_identities` row.                                                                             |
| `PUT`   | `/api/admin/inboxes/:email/assignments` | Body `{ userIds: string[] }`. Replaces the full member assignment set (delete + insert in a transaction). Admins are implicitly allowed and not representable here. |
| `GET`   | `/api/admin/users/:id/inboxes`          | Convenience lookup for the user-admin page.                                                                                                                         |

### Existing routers — apply filters

| Router                   | Change                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stats-router`           | `recipients` filtered; `totalEmails` / `unreadCount` / `totalPeople` each recomputed through `inboxFilter`. `senderIdentities` in response filtered to allowed inboxes.                                                   |
| `emails-router`          | All list queries (`by-person`, sent, search) apply `inboxFilter(allowed, emails.recipient)` (and `sent_emails.fromAddress` for sent). Single-email GET returns 404 (not 403) when disallowed, to avoid leaking existence. |
| `people-router`          | List filtered to people having ≥1 email in an allowed inbox (subquery on `emails.recipient`). Detail GET: same 404-on-disallow behavior.                                                                                  |
| `send-router`            | Compose + reply call `assertInboxAllowed(allowed, fromAddress)` before sending.                                                                                                                                           |
| `sequences-router`       | List filtered by enrollment `fromAddress` ∈ allowed. Create/update: assert fromAddress allowed.                                                                                                                           |
| `email-templates-router` | List: admins see all; members see `from_address IS NULL OR from_address IN (allowed)`. Create/update: members must set `from_address` to an allowed inbox.                                                                |

### Deleted

`/api/sender-identities` router and its three endpoints are removed. Display-name mutations move to `/api/admin/inboxes/:email`. The `sender_identities` **table** stays (consumed by `formatFromAddress` when sending).

## Frontend

### Route & navigation

- `src/pages/SettingsPage.tsx` → `src/pages/InboxesPage.tsx` (default export `InboxesPage`).
- Route `/settings` → `/inboxes` in `src/App.tsx`. Add a `<Navigate to="/inboxes" replace />` for `/settings` to preserve old bookmarks.
- `src/components/Sidebar.tsx`: rename link label "Settings" → "Inboxes", `to="/inboxes"`. Show only when `user.role === "admin"`.

### `InboxesPage` (admin-only)

Single table, one row per inbox:

- **Address** — read-only (e.g., `jane@foo.com`).
- **Display name** — inline editable, saves on blur via `PATCH /api/admin/inboxes/:email`.
- **Members** — multi-select combobox of non-admin users. Saves via `PUT /api/admin/inboxes/:email/assignments`. Admins appear as a disabled "All admins" chip for clarity.

Page-level guard: if `user.role !== "admin"`, render a "Forbidden" state and do not fetch.

### Member-facing behavior

- `ComposeModal` and `ReplyComposer` "From" dropdowns already consume `stats.recipients` + `stats.senderIdentities`. No frontend change is needed beyond the server-side filtering — members simply see fewer options.
- Empty-state: if `stats.recipients` is empty for a member, main views show "No inboxes assigned yet. Ask an admin to grant you access."
- Sidebar's recipient filter: members see only their assigned inboxes; admins unchanged.
- Delete `src/components/SenderIdentitiesSettings.tsx` (superseded by `InboxesPage`).

### `src/lib/api.ts`

- Remove: `fetchSenderIdentities`, `upsertSenderIdentity`, `deleteSenderIdentity`.
- Add: `fetchAdminInboxes`, `updateInboxDisplayName`, `updateInboxAssignments`, and `fetchAdminUsers` (if not already present) to populate the member combobox.

## Error Handling & Edge Cases

- **Read disallowed:** return 404, not 403, to avoid leaking existence of other inboxes' data.
- **Write disallowed:** return 403 `{ error: "Inbox not allowed" }`.
- **Admin endpoints:** 403 for non-admins (existing middleware).
- **Member with zero inboxes:** list endpoints return empty; stats return zeros; UI shows empty state. No special auth failure.
- **User deleted:** `onDelete: cascade` on `inbox_permissions.user_id` cleans up.
- **Promotion to admin:** existing assignment rows become redundant but harmless. Not auto-deleted so demotion restores prior access without surprise.
- **Unregistered inbox** (address appears in `emails.recipient` but has no `sender_identities` row): still assignable. Admin UI lists the union.
- **Unassigned incoming mail:** stored normally; only admins see it until an assignment is made.
- **Revocation race:** permissions re-read per request, so the next API call enforces the new set. Stale UI state resolves on the next fetch.

## Testing

### Unit

- `resolveAllowedInboxes` returns correct shape for: admin, member with N inboxes, member with zero inboxes.
- `inboxFilter` produces correct Drizzle conditions in each case.

### Integration (Vitest + miniflare D1, matching existing test style)

- Admin sees all inboxes across stats, emails, people, send.
- Member with one inbox sees only that inbox's data across stats, emails, people, sent.
- Member send from disallowed inbox → 403.
- Member read nonexistent vs disallowed email → both 404 (no existence leak).
- `PUT /api/admin/inboxes/:email/assignments` replaces the full set (removal is durable).
- Demotion admin → member: previously created content remains accessible only through allowed inboxes.
- Templates: member can create a template with an allowed `fromAddress`; blocked from disallowed; sees global (null) templates.

### Manual

1. Admin provisions a member with one inbox → member logs in, sees only that inbox and its threads/people.
2. Admin revokes → member refreshes, inbox disappears and empty state shows when applicable.
3. Admin renames an inbox's display name → compose dropdown reflects the change.

## Migration

- New table `inbox_permissions` (additive — empty at rollout; all existing members become zero-inbox users).
- Additive column `email_templates.from_address` (nullable, no backfill).
- No data migration required.

**Rollout ordering note:** because adding `inbox_permissions` with zero rows immediately blocks members from every inbox, deploy the migration and the admin assignment UI together, and notify admins to provision members before (or immediately after) the release.
