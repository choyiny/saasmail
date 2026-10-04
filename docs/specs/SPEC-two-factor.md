# SPEC: Two-factor sign-in (TOTP + recovery codes) and durable auth rate limiting

Stage 9 (trust and safety), slice 5 of 5. Depends on `docs/archive/SPEC-audit-log.md` (events). Label `minor`.

## Why

The passkey gate forces every user to _register_ a passkey, but `LoginPage` still accepts
email + password alone, and `passkeyRequired()` only checks that a passkey exists. A leaked password is
a full session: all mail the user can see, every API key they can create, every inbox they may send
from. Mailflare ships TOTP with recovery codes; better-auth 1.6.28 (already our auth library) ships a
`twoFactor` plugin that does exactly that and leaves passkey sign-in alone (its hook covers
`/sign-in/email`, `/sign-in/username` and `/sign-in/phone-number`, verified in
`node_modules/better-auth/dist/plugins/two-factor/index.mjs`).

Also: better-auth's rate limiter is in-memory, i.e. per isolate on Workers. A TOTP code is six digits,
so the verification endpoint needs a limiter that holds across isolates.

## Decisions (proposed 2026-10-03)

1. Per-user opt-in TOTP, with 10 single-use recovery codes, through better-auth's `twoFactor` plugin.
   It applies to password sign-in only; passkey sign-in is already two factors and bypasses it, which
   is the intended behaviour, not a gap.
2. An admin can reset (disable) a locked-out user's second factor. Admins see who has it on.
3. Optional setting `password_sign_in_with_passkey: "allowed" | "blocked"` (default `allowed`). When
   `blocked`, a user who has a passkey cannot sign in with a password at all ("Use your passkey").
   This is the strongest option for teams that want it and costs one hook; it stays off by default
   because the e2e suite and `DISABLE_PASSKEY_GATE` dev flows sign in with passwords.
4. Forcing every user to enable TOTP is out of scope: the passkey gate already guarantees a
   phishing-resistant factor is registered for every account, and better-auth cannot tell a password
   session from a passkey session after the fact.
5. Auth rate limiting moves to D1 (`customStorage` with an atomic `consume`), keyed by
   `cf-connecting-ip`, so the plugin's `/two-factor/*` rule (3 requests per 10 s) and the default
   sign-in rules hold across isolates. Sessions are untouched.

## 1. Server

**Files:** `worker/src/auth/index.ts`, `worker/src/db/auth.schema.ts` (regenerated), new
`worker/src/auth/rate-limit-storage.ts`, `worker/src/db/auth-rate-limits.schema.ts`, `schema.ts`,
migrations, `helpers.ts`, `worker-configuration.d.ts`, `wrangler.jsonc.example`.

- Plugin: `twoFactor({ issuer: env?.TWO_FACTOR_ISSUER ?? "saasmail", skipVerificationOnEnable: false,
backupCodeOptions: { amount: 10 } })` added to `plugins`. `yarn auth:generate` regenerates
  `auth.schema.ts` (adds `twoFactors` and `users.twoFactorEnabled`); then `yarn db:generate`; then
  `applyMigrations()` in `helpers.ts`.
- Rate limiting: `rateLimit: { enabled: !isDevEnvironment(env), window: 60, max: 60, customStorage:
d1RateLimitStorage(db) }` and `advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip"]`.
  `d1RateLimitStorage` implements `get`, `set` and `consume` over

  ```
  auth_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL)
  ```

  `consume(key, rule)`: one statement — `INSERT … ON CONFLICT DO UPDATE SET count = CASE WHEN
expires_at <= now THEN 1 ELSE count + 1 END, window_start = CASE … END, expires_at = CASE … END
RETURNING count, expires_at` — then `allowed = count <= rule.max`, `retryAfter = expires_at - now`.
  Expired rows are pruned in the hourly chain (1,000 per pass).

- Hooks (`hooks.before` / `hooks.after`):
  - `before /sign-in/email`: when `password_sign_in_with_passkey === "blocked"`, look the user up by
    email; if they have a passkey → `APIError("FORBIDDEN", { code: "PASSKEY_SIGN_IN_REQUIRED",
message: "Use your passkey to sign in." })`. Unknown emails fall through to the normal failure
    (no account enumeration).
  - `after /sign-in/email`, `/passkey/verify-authentication`, `/two-factor/verify-totp`,
    `/two-factor/verify-backup-code`:
    emit `auth.sign_in` (method `password`, `passkey`, `totp`, `recovery_code`) or `auth.sign_in_failed`.
  - `after /two-factor/enable` (completed by the first `verify-totp`), `/two-factor/disable`: emit
    `user.two_factor_enabled` / `user.two_factor_disabled`.
- Admin reset: `POST /api/admin/users/{id}/two-factor/reset` (admin, passkey-gated, not for yourself):
  deletes the user's `twoFactors` row, sets `users.two_factor_enabled = 0`, emits
  `user.two_factor_reset`. `GET /api/admin/users` gains `twoFactorEnabled` per user.
- The session user returned by better-auth (`useSession()` on the client) carries `twoFactorEnabled`;
  the plugin adds the field, so no saasmail route changes for it.

## 2. Client and pages

**Files:** `src/lib/auth-client.ts`, `src/pages/LoginPage.tsx`, new `src/pages/TwoFactorPage.tsx`,
`src/App.tsx` (`/two-factor`), `src/pages/SettingsPage.tsx` (Security section),
`src/pages/AdminUsersPage.tsx`, `package.json` (`qrcode.react`, exact pin, `yarn install
--update-checksums`).

- `twoFactorClient({ onTwoFactorRedirect() { window.location.assign("/two-factor") } })` in the auth
  client. `LoginPage`: after `signIn.email` resolves with `twoFactorRedirect`, navigate to
  `/two-factor`; a `PASSKEY_SIGN_IN_REQUIRED` error switches the page to passkey mode with the message.
- `/two-factor`: six-digit input (auto-submit on the sixth digit), "Trust this device" checkbox
  (`trustDevice: true`), "Use a recovery code instead" (switches to a text field →
  `verifyBackupCode`), errors from the server verbatim, a "Back to sign-in" link. Unauthenticated
  layout like LoginPage.
- Settings → Security:
  - Status line ("Two-factor sign-in is off / on since …").
  - **Turn on**: password prompt → `twoFactor.enable({ password })` → QR (`qrcode.react` `QRCodeSVG`
    of `totpURI`) + "Can't scan? Enter this key" (the secret from the URI) → code input →
    `verifyTotp({ code })` → the recovery codes, shown once with Copy and Download (.txt) and a
    "I saved them" confirmation → done.
  - **Turn off**: password prompt → `twoFactor.disable({ password })`.
  - **New recovery codes**: password prompt → `generateBackupCodes({ password })`, shown once.
  - Passkeys: the existing list/add/remove (`/api/user/passkeys`, `SetupPasskeyPage`) is linked or
    embedded here; removal emits `user.passkey_removed` through the `/passkey/delete-passkey` hook.
- Admin → Users: a "2FA" column (On/Off) and a "Reset 2FA" action with a confirmation that names the
  user.
- Settings → Security (admins): the `password_sign_in_with_passkey` select with a sentence explaining
  the effect and the dev-flow caveat.

## Tests

- Worker: `twoFactor` is in the plugin list; `consume` admits `max` and refuses `max + 1` within the
  window, resets after it, and two concurrent consumes count both; the `blocked` hook refuses a
  passkey user's password sign-in and lets a passkey-less user through; the admin reset route clears
  the row, refuses non-admins and self; the `twoFactorEnabled` field.
- Web (vitest): `/two-factor` submits the code and the trust flag; the recovery-code path; Settings
  enable flow renders the QR and the codes once; Login handles `twoFactorRedirect` and
  `PASSKEY_SIGN_IN_REQUIRED`.
- e2e: unchanged flows still pass (the setting defaults to `allowed`; the e2e user has no TOTP). One new
  e2e: enable TOTP in Settings with a known secret (generate codes with `otpauth` in the test), sign out,
  sign in with password → `/two-factor` → code → dashboard.

## Docs and CHANGELOG

- `docs/users-and-api-keys.md`: a "Two-factor sign-in" section (how it relates to passkeys, recovery
  codes, admin reset, the passkey-only setting). `docs/configuration.md`: `TWO_FACTOR_ISSUER`
  (optional). `docs/updating.md`: run `yarn db:migrate:prod` (new auth tables) before deploying.
- CHANGELOG `### Added`: **Two-factor sign-in.** … and **Sign-in rate limits hold across Workers.** …
