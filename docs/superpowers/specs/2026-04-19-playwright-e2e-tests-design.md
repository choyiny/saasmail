# Playwright E2E Tests — Design

**Date:** 2026-04-19
**Status:** Approved, ready for implementation plan

## Goal

Add end-to-end browser tests, driven by Playwright, that exercise the saasmail UI against a locally running `DEMO_MODE=1` instance. The suite covers the main user-facing flows: authentication, inbox CRUD, sequence CRUD, compose/send, thread-mode display, chat-mode display, email template CRUD, API-key management, and invite acceptance.

## Non-goals

- Visual regression / screenshot diffing.
- Cross-browser coverage (Chromium only for the baseline suite).
- Mobile viewport testing.
- Performance/Lighthouse assertions.
- Accessibility audits via axe.
- Testing real inbound email (Cloudflare Email Workers can't run locally; seeded inbox state stands in).
- Testing real outbound email (`DEMO_MODE` intentionally short-circuits; unit tests cover provider logic).
- A broad `data-testid` sweep across the app. Only add test ids where specs need them and role selectors are ambiguous.

## Architecture

### Test environment

- Tests run against a local `vite dev` server started by Playwright's `webServer` config.
- Demo flags (`DEMO_MODE=1`, `DISABLE_PASSKEY_GATE=true`) neutralise real email-sending and the passkey gate.
- A new `--mode e2e` targets a dedicated miniflare persist directory (`.wrangler/state/e2e/`) so the E2E SQLite file is isolated from the developer's `yarn dev` state.
- Same `saasmail-db` D1 binding name — only the on-disk location differs.

### Database state (per-describe-block reset — option D)

- `globalSetup` runs once per test run:
  1. Delete `.wrangler/state/e2e/` entirely.
  2. Apply migrations against the fresh local SQLite via `wrangler d1 migrations apply saasmail-db --local --persist-to .wrangler/state/e2e/`.
  3. Execute `seeds/e2e.sql` to create one admin user and two inboxes (one thread, one chat) with seeded inbound messages.
  4. Sign the admin in via the BetterAuth sign-in endpoint and save cookies to `e2e/.auth/admin.json`.
- Each spec file runs `test.describe.serial` with a `beforeAll` that truncates and re-seeds the DB via `wrangler d1 execute --local` against the running miniflare. This avoids file-lock contention and keeps per-file runs fast.
- `fullyParallel: false`, `workers: 1` — specs share one live dev server and one SQLite file.

### Authentication (option D)

- Most specs load the pre-saved admin `storageState` so they start authenticated.
- `auth.spec.ts` runs with `storageState: undefined` to drive the real setup wizard and login UI.
- `invites.spec.ts` opens a fresh browser context (no storageState) to accept an invite as a new user.

### Server lifecycle

- `playwright.config.ts` `webServer` entry spawns `yarn dev:e2e` on port 8788.
- Waits for `GET /api/health` to return 200 before running specs.
- `webServer.reuseExistingServer: !process.env.CI` — fast local iteration, guaranteed clean slate on CI.

## Directory layout

```
e2e/
  .auth/                     # generated, gitignored — storageState files
  fixtures/
    test.ts                  # extended test with auth + unique-name helpers
  support/
    reset-db.ts              # delete/persist + migrate + seed
    seed.ts                  # programmatic create-via-API helpers
    login.ts                 # BetterAuth API-based login for globalSetup
    selectors.ts             # shared data-testid constants
  specs/
    auth.spec.ts
    inboxes.spec.ts
    sequences.spec.ts
    compose.spec.ts
    thread-display.spec.ts
    chat-display.spec.ts
    templates.spec.ts
    api-keys.spec.ts
    invites.spec.ts
  global-setup.ts
  global-teardown.ts
scripts/
  e2e-hash-seed-password.ts  # one-shot util: prints BetterAuth scrypt hash for seed SQL
seeds/
  e2e.sql                    # 1 admin, 2 inboxes (thread + chat), seeded inbound mail
playwright.config.ts         # repo root
```

### .gitignore additions

```
e2e/.auth/
.wrangler/state/e2e/
test-results/
playwright-report/
```

### package.json additions

Dev dep: `@playwright/test`.

Scripts:

```
"dev:e2e":        "DEMO_MODE=1 DISABLE_PASSKEY_GATE=true vite dev --port 8788 --mode e2e"
"test:e2e":       "playwright test"
"test:e2e:ui":    "playwright test --ui"
"test:e2e:debug": "PWDEBUG=1 playwright test"
```

## Seed data

`seeds/e2e.sql` — intentionally minimal so specs own their own data:

- One admin user: `admin@e2e.test` / password `e2e-admin-pw`.
- One member user: `member@e2e.test` / password `e2e-member-pw`, no inbox assignments initially (used by `inboxes.spec.ts` to verify scoping after assignment).
- Password hashes are pre-computed by `scripts/e2e-hash-seed-password.ts` using the same scrypt params as the runtime BetterAuth config and committed verbatim into the SQL file.
- Two inboxes:
  - `marketing@e2e.test` in `thread` mode.
  - `support@e2e.test` in `chat` mode.
- Admin is assigned to both inboxes; one `sender_identity` row per inbox.
- Two fake contacts, each with two inbound messages on each inbox, so display specs have content.

`invites.spec.ts` uses a different email (`invitee@e2e.test`) so it never collides with the seeded member.

Anything beyond this (templates, sequences, extra people, extra users) is created by the spec that needs it via `support/seed.ts` helpers, which POST to the real app routers using the admin cookie. Tests never write directly to SQLite.

## Test helpers

`support/seed.ts` exports (minimum):

```ts
createInbox(name, mode)
createTemplate(inboxId, name, html)
createSequence(inboxId, name, steps[])
createApiKey(name)
createInvite(email, role, inboxIds)
enrollContact(sequenceId, personId, vars)
```

`fixtures/test.ts` extends Playwright's `test` with:

- `uniqueName(prefix)` — returns `${prefix}-${slug(testInfo.title)}-${nanoid(6)}` to avoid cross-test collisions on retries and describe-level reruns.
- `api` — an `APIRequestContext` bound to the admin storageState cookie.

`support/selectors.ts` centralises the `data-testid` strings we rely on so additions stay grep-able. Selector preference: role → label → text → `data-testid`. We add `data-testid` only when role selectors are genuinely ambiguous.

## Spec-by-spec scope

Each spec uses admin `storageState` unless noted.

### 1. `auth.spec.ts` (no storageState)

- Fresh DB with no users → visit `/` → setup wizard → create admin → land on inbox.
- Log out → log in with same credentials → land on inbox.
- Invalid password shows error.

### 2. `inboxes.spec.ts`

- Create inbox `onboarding@…` (thread mode) — appears in list.
- Rename display name, toggle to chat mode — persists after reload.
- Assign a second (seeded member) user — scoping verified via API GET as that user.
- Delete inbox — removed from list, confirm dialog required.

### 3. `sequences.spec.ts`

- Create sequence with 3 steps (template + delay per step).
- Edit step (change delay, reorder).
- Remove step.
- Enroll a seeded contact → enrollment row appears.
- Cancel enrollment → status flips to `cancelled`.
- Delete sequence.

### 4. `compose.spec.ts`

- Open person detail → compose modal → send reply.
- Assert success toast.
- Assert backend: new `sent_emails` row with id `demo_…` via API.
- Empty body → client validation blocks submit.

### 5. `thread-display.spec.ts`

- Open `marketing@…` (thread mode) → person with multi-message thread.
- Assert subject lines visible, quoted history collapsible, HTML content rendered.
- Reply composer present below thread.

### 6. `chat-display.spec.ts`

- Open `support@…` (chat mode) → person with multi-message thread.
- Assert bubble layout (`data-testid="chat-bubble"`), no subject lines, no quoted history.
- Reply composer is the Slack-style inline input.

### 7. `templates.spec.ts`

- Create template with `{{name}}` + `{{product}}` vars.
- Preview renders interpolated values.
- Edit HTML, save, reload — persists.
- Delete template.

### 8. `api-keys.spec.ts`

- Create API key → full `sk_…` shown once.
- Use that key via `page.request` to hit `/api/v1/emails` → 200.
- Revoke key → same call returns 401.
- Key appears in list with masked prefix.

### 9. `invites.spec.ts`

- Admin creates invite for `invitee@e2e.test` → invite URL returned.
- Open invite URL in a fresh context (no storageState) → signup form.
- Complete signup → invitee lands on inbox.
- Invitee only sees assigned inbox (other inbox hidden).

## Demo-mode verification points

| Demo behavior                                                 | Covered by                     |
| ------------------------------------------------------------- | ------------------------------ |
| `send-router` returns `demo_…` id, no provider call           | `compose.spec.ts`              |
| Sequence enrollments create rows, first email stays `pending` | `sequences.spec.ts`            |
| Scheduled/queue handlers short-circuit                        | Not E2E (covered by vitest)    |
| Inbound handler unreachable                                   | Not E2E (seeded via SQL + API) |

## Risks & mitigations

- **BetterAuth password-hash drift.** The hash baked into `seeds/e2e.sql` must match the runtime scrypt params. Mitigation: `scripts/e2e-hash-seed-password.ts` regenerates the hash on demand; re-run if auth config changes. Document in the spec README.
- **Flakiness from React Query refetches.** Use `expect.poll` and role-based locators. No `waitForTimeout` in specs.
- **SQLite file lock while server is live.** Per-file resets issue SQL (`wrangler d1 execute --local --command`) rather than deleting the file. File deletion happens only in `globalSetup`, before the server starts.
- **Port conflicts.** Fixed 8788. CI uses `reuseExistingServer: false`; local reuses.
- **Parallelism.** `fullyParallel: false`, workers `1`. Within-file, `test.describe.serial`.

## CI

GitHub Actions job `e2e`:

1. `yarn install --frozen-lockfile`
2. `yarn playwright install --with-deps chromium`
3. `yarn test:e2e`

Reporters: `list` locally, `github` + `html` on CI. Upload `playwright-report/` on failure. Cache `~/.cache/ms-playwright` and `node_modules`. Chromium only — add other browsers later if a real cross-browser bug surfaces.

## Deliverables checklist

- [ ] `@playwright/test` installed.
- [ ] `playwright.config.ts` at repo root.
- [ ] `e2e/` tree with fixtures, support, specs, global-setup, global-teardown.
- [ ] `seeds/e2e.sql` + `scripts/e2e-hash-seed-password.ts`.
- [ ] `dev:e2e` / `test:e2e` / `test:e2e:ui` / `test:e2e:debug` scripts.
- [ ] Vite `--mode e2e` wired to the dedicated miniflare persist path.
- [ ] All 9 spec files pass locally and on CI.
- [ ] `.gitignore` updated.
- [ ] Minimal `data-testid` additions where role selectors are ambiguous.
- [ ] `README.md` gets a short "Running E2E tests" section under Local Development.
