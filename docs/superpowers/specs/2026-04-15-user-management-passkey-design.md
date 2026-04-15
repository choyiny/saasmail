# User Management Portal & Passkey Authentication

## Overview

Add a user management portal where admins can invite users to the cmail platform, assign roles (admin/member), and manage existing users. Enforce passkey (WebAuthn) authentication: every user must register a passkey before accessing any emails, and all subsequent logins use passkey only.

## Roles

| Role     | Permissions                                                                  |
| -------- | ---------------------------------------------------------------------------- |
| `admin`  | Full access: inbox, compose, reply, templates, user management, invite users |
| `member` | Inbox, compose, reply, templates. No access to user management or inviting.  |

## User Lifecycle

1. Admin generates an invite link (selects role, optional email restriction, expiry)
2. Admin shares the link manually (Slack, email, etc.)
3. New user opens `/invite/:token` → enters name, email, password → account created with invite's role → auto-signed in
4. Immediately redirected to `/setup-passkey` — a blocking interstitial. Cannot access inbox until a passkey is registered.
5. User registers a passkey via WebAuthn browser flow
6. Redirected to inbox with full access
7. All future logins are **passkey-only** — no email/password login form for returning users

The first admin (created via `/onboarding`) follows the same passkey requirement — after onboarding, they must register a passkey before accessing the inbox.

## Auth & Passkey Architecture

### BetterAuth Config Changes

- Add `passkey()` plugin to server config (provides WebAuthn registration and authentication endpoints)
- Add `passkeyClient()` plugin to frontend auth client
- `emailAndPassword.disableSignUp` remains `true` — signup only through invite acceptance using admin plugin's `createUser`

### Passkey Endpoints (provided by BetterAuth plugin)

- `POST /api/auth/passkey/generate-register-options` — get WebAuthn registration challenge
- `POST /api/auth/passkey/verify-registration` — verify and store passkey
- `POST /api/auth/passkey/generate-authenticate-options` — get WebAuthn auth challenge
- `POST /api/auth/passkey/verify-authentication` — verify passkey and create session

### Custom Endpoints

- `GET /api/user/passkeys` — returns `{ hasPasskey: boolean }` for the current user. Used by `AuthGuard` to enforce the passkey gate.

### Frontend Gate

`AuthGuard` updated to check passkey status after confirming a valid session:

- Session exists + has passkey → allow access
- Session exists + no passkey → redirect to `/setup-passkey`
- No session → redirect to `/login`

## Invitation System

### Database Schema

Replace the existing BetterAuth-generated `invitations` table with a custom one:

```
invitations
├── id: text (primary key, UUID)
├── token: text (unique, not null, UUID)
├── role: text (not null, "admin" | "member", default "member")
├── email: text (nullable — if set, only this email can accept)
├── expiresAt: integer (timestamp, not null)
├── usedBy: text (nullable, foreign key → users.id)
├── usedAt: integer (timestamp, nullable)
├── createdBy: text (not null, foreign key → users.id)
├── createdAt: integer (timestamp, not null)
```

### API Endpoints

**Admin-only (behind `requireAdmin` middleware):**

| Method | Path                 | Description                                                                                     |
| ------ | -------------------- | ----------------------------------------------------------------------------------------------- |
| POST   | `/api/admin/invites` | Create invite. Body: `{ role, email?, expiresInDays }`. Returns invite with token and full URL. |
| GET    | `/api/admin/invites` | List all invites with status (pending/used/expired).                                            |

**Public:**

| Method | Path                  | Description                                                                                                               |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/invites/:token` | Check invite validity. Returns `{ valid, role, email? }` or error.                                                        |
| POST   | `/api/invites/accept` | Accept invite. Body: `{ token, name, email, password }`. Creates user, marks invite used, auto-signs in. Returns session. |

### Invite Acceptance Logic

1. Validate token exists, is not used, is not expired
2. If invite has email restriction, verify submitted email matches
3. Create user via `auth.api.createUser()` with invite's role
4. Mark invite as used (`usedBy`, `usedAt`)
5. Auto-sign in the new user (create session)
6. Frontend redirects to `/setup-passkey`

## User Management Portal

### API Endpoints (admin-only)

| Method | Path                        | Description                                                  |
| ------ | --------------------------- | ------------------------------------------------------------ |
| GET    | `/api/admin/users`          | List all users: id, name, email, role, createdAt, hasPasskey |
| PATCH  | `/api/admin/users/:id/role` | Update role. Body: `{ role }`. Admin cannot change own role. |
| DELETE | `/api/admin/users/:id`      | Delete user. Admin cannot delete themselves.                 |

### Frontend — `/admin/users`

- Table with columns: Name, Email, Role (badge), Passkey Status, Joined
- "Invite User" button → dialog with: role selector (admin/member), optional email field, expiry (days). On submit, shows the generated invite link to copy.
- Per-user actions: change role (dropdown), delete (with confirmation)
- Nav link "Users" in header, visible only when `session.user.role === "admin"`

## Login Page Changes

- Default view: single "Sign in with Passkey" button (triggers WebAuthn browser flow)
- No email/password form for returning users
- The password form only exists on `/invite/:token` (invite acceptance) and `/onboarding` (first admin setup)

## Onboarding Page Changes

- After the first admin creates their account via the existing setup flow, redirect to `/setup-passkey` instead of directly to inbox

## New Pages

### `/invite/:token` — Invite Acceptance

- On load: calls `GET /api/invites/:token` to validate
- If invalid/expired: show error message
- If valid: show registration form (name, email — pre-filled if invite has email restriction, password, confirm password)
- On submit: calls `POST /api/invites/accept`, then redirects to `/setup-passkey`

### `/setup-passkey` — Passkey Registration (Blocking)

- Shows explanation: "For security, you need to register a passkey to access cmail"
- "Register Passkey" button triggers WebAuthn registration flow via `passkeyClient`
- On success: redirects to `/` (inbox)
- No skip, no back button — this is mandatory

### `/admin/users` — User Management

- Described above in User Management Portal section

## File Changes

### New Files

| File                                  | Purpose                                |
| ------------------------------------- | -------------------------------------- |
| `worker/src/routers/admin-router.ts`  | Invite + user management API endpoints |
| `worker/src/routers/user-router.ts`   | Passkey status endpoint                |
| `worker/src/db/invitations.schema.ts` | Custom invitations table schema        |
| `src/pages/AdminUsersPage.tsx`        | User management portal page            |
| `src/pages/InviteAcceptPage.tsx`      | Invite acceptance/registration page    |
| `src/pages/SetupPasskeyPage.tsx`      | Passkey registration interstitial      |

### Modified Files

| File                           | Change                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `worker/src/auth/index.ts`     | Add `passkey()` plugin                                                              |
| `worker/src/index.ts`          | Mount admin router, user router, add `requireAdmin` middleware                      |
| `worker/src/db/auth.schema.ts` | Regenerate to include passkey tables                                                |
| `worker/src/db/index.ts`       | Export invitations schema                                                           |
| `src/lib/auth-client.ts`       | Add `passkeyClient()` plugin                                                        |
| `src/lib/api.ts`               | Add invite, user management, passkey status API functions                           |
| `src/App.tsx`                  | Add routes (`/invite/:token`, `/setup-passkey`, `/admin/users`), update `AuthGuard` |
| `src/pages/LoginPage.tsx`      | Replace email/password form with passkey-only login                                 |
| `src/pages/OnboardingPage.tsx` | Redirect to `/setup-passkey` after first admin creation                             |
| `src/pages/InboxPage.tsx`      | Add "Users" nav link for admins                                                     |
| New migration file             | Invitations table + passkey schema                                                  |
