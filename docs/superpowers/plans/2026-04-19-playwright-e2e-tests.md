# Playwright E2E Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Playwright end-to-end tests that drive the saasmail UI against a local `DEMO_MODE=1` dev server, covering auth, inbox CRUD, sequence CRUD, compose, thread/chat display, templates, API keys, and invite acceptance.

**Architecture:** Playwright spawns `vite dev --port 8788` via its `webServer` config with `DEMO_MODE=1` + `DISABLE_PASSKEY_GATE=true`. `globalSetup` wipes the local miniflare D1, re-applies migrations, executes a minimal seed SQL (inboxes, people, inbound emails), creates the admin via the setup HTTP API, creates the member via the invite flow, and saves a logged-in cookie into `e2e/.auth/admin.json`. Each spec uses `test.describe.serial`, resets per-file state via SQL truncation through `wrangler d1 execute --local`, and mostly uses the admin storageState. Auth and invite specs override storageState to exercise real UI.

**Tech Stack:** Playwright Test, Vite, Cloudflare Vite plugin, Wrangler CLI (local D1), Hono, BetterAuth, React Testing patterns.

**Deviations from spec** (accepted simplifications, surfaced after exploring the code):

1. No dedicated miniflare persist dir for E2E. The `@cloudflare/vite-plugin` doesn't expose `persistTo`, and wrangler's `--persist-to` isn't wired into the plugin either. Result: E2E and `yarn dev` share the local D1 SQLite file. `yarn test:e2e` will overwrite dev data. README documents this clearly.
2. No pre-hashed password seed. BetterAuth uses its own password hashing (scrypt-based), so `seeds/e2e.sql` omits users. Admin + seeded member are created via real HTTP endpoints in `globalSetup`. The `scripts/e2e-hash-seed-password.ts` helper from the spec is dropped as unnecessary.

---

## File Structure

```
playwright.config.ts                    # NEW — repo-root Playwright config
seeds/e2e.sql                           # NEW — inboxes, people, emails (no users)
e2e/
  global-setup.ts                       # NEW — wipe DB, seed, create users, save storage state
  global-teardown.ts                    # NEW — stop any child processes (no-op for now)
  fixtures/test.ts                      # NEW — extended Playwright test with uniqueName + api
  support/
    reset-db.ts                         # NEW — shell helpers: wipeAndSeed(), truncateData()
    login.ts                            # NEW — HTTP helpers: createAdmin(), loginViaApi(), saveStorageState()
    seed.ts                             # NEW — programmatic API helpers: createInbox, createTemplate, etc.
    selectors.ts                        # NEW — shared data-testid string constants
  specs/
    auth.spec.ts                        # NEW
    inboxes.spec.ts                     # NEW
    sequences.spec.ts                   # NEW
    compose.spec.ts                     # NEW
    thread-display.spec.ts              # NEW
    chat-display.spec.ts                # NEW
    templates.spec.ts                   # NEW
    api-keys.spec.ts                    # NEW
    invites.spec.ts                     # NEW
package.json                            # MODIFY — add dev dep + 4 scripts
.gitignore                              # MODIFY — add e2e artifacts
README.md                               # MODIFY — add "Running E2E tests" subsection
.github/workflows/e2e.yml               # NEW — CI job
src/pages/*.tsx                         # MODIFY — narrow data-testid additions as specs require (per-spec task)
```

---

## Task 1: Install Playwright & update .gitignore

**Files:**

- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install @playwright/test as a dev dependency**

Run:

```bash
yarn add -D @playwright/test
```

Expected: `@playwright/test` added to `devDependencies` in `package.json`.

- [ ] **Step 2: Install Chromium browser for Playwright**

Run:

```bash
yarn playwright install chromium
```

Expected: Chromium downloaded to `~/.cache/ms-playwright/`.

- [ ] **Step 3: Add E2E entries to `.gitignore`**

Append to `.gitignore`:

```
# Playwright
e2e/.auth/
test-results/
playwright-report/
.playwright/
```

- [ ] **Step 4: Commit**

```bash
git add package.json yarn.lock .gitignore
git commit -m "chore(e2e): install @playwright/test and ignore artifacts"
```

---

## Task 2: Add `dev:e2e` and `test:e2e` scripts

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Add four scripts to `package.json`**

In the `"scripts"` block, add (keep existing scripts):

```json
"dev:e2e": "DEMO_MODE=1 DISABLE_PASSKEY_GATE=true vite dev --port 8788",
"test:e2e": "playwright test",
"test:e2e:ui": "playwright test --ui",
"test:e2e:debug": "PWDEBUG=1 playwright test"
```

- [ ] **Step 2: Verify dev:e2e starts the server**

Run in one terminal:

```bash
yarn dev:e2e
```

Expected: Vite starts on `http://localhost:8788`, Cloudflare plugin initializes miniflare, no crashes.

In another terminal:

```bash
curl -s http://localhost:8788/api/health
```

Expected: `{"status":"ok"}`.

Stop the server with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(e2e): add dev:e2e and test:e2e scripts"
```

---

## Task 3: Create `seeds/e2e.sql`

**Files:**

- Create: `seeds/e2e.sql`

The E2E seed creates only the data that can't be bootstrapped via HTTP APIs in `globalSetup`: inboxes (sender_identities), people, and inbound emails for display specs. Users are created via the setup + invite APIs in Task 7.

- [ ] **Step 1: Create `seeds/e2e.sql`**

Create file `seeds/e2e.sql` with exactly this content:

```sql
-- E2E seed data: inboxes + people + inbound emails.
-- Users are created via HTTP APIs in e2e/global-setup.ts.

-- Clean tables (idempotent for repeated runs)
DELETE FROM sequence_emails;
DELETE FROM sequence_enrollments;
DELETE FROM sequences;
DELETE FROM api_keys;
DELETE FROM email_templates;
DELETE FROM invitations;
DELETE FROM emails;
DELETE FROM sent_emails;
DELETE FROM people;
DELETE FROM inbox_permissions;
DELETE FROM sender_identities;

-- Inboxes
INSERT INTO sender_identities (email, displayName, displayMode, createdAt, updatedAt)
VALUES
  ('marketing@e2e.test', 'Marketing', 'thread', unixepoch() * 1000, unixepoch() * 1000),
  ('support@e2e.test',   'Support',   'chat',   unixepoch() * 1000, unixepoch() * 1000);

-- People
INSERT INTO people (id, email, name, lastEmailAt, unreadCount, totalCount, createdAt, updatedAt)
VALUES
  ('p_alice', 'alice@customers.test', 'Alice Anderson', unixepoch() * 1000, 2, 4, unixepoch() * 1000, unixepoch() * 1000),
  ('p_bob',   'bob@customers.test',   'Bob Brown',      unixepoch() * 1000, 2, 4, unixepoch() * 1000, unixepoch() * 1000);

-- Inbound emails. Two per (person, inbox) so display specs have thread context.
-- marketing@ (thread mode): subjects vary; bodies include quoted history markers
-- support@ (chat mode): short bodies, no subject context needed

INSERT INTO emails (id, personId, recipient, subject, bodyHtml, bodyText, messageId, isRead, receivedAt, createdAt)
VALUES
  ('e_m_a1', 'p_alice', 'marketing@e2e.test', 'Welcome to our product', '<p>Hi Alice,</p><p>Welcome aboard!</p>',        'welcome', 'mid_m_a1', 0, unixepoch() * 1000 - 3600000, unixepoch() * 1000 - 3600000),
  ('e_m_a2', 'p_alice', 'marketing@e2e.test', 'Re: Welcome to our product', '<p>Thanks for signing up!</p><blockquote>On date, we wrote: Hi Alice</blockquote>', 'thanks', 'mid_m_a2', 0, unixepoch() * 1000 - 1800000, unixepoch() * 1000 - 1800000),
  ('e_m_b1', 'p_bob',   'marketing@e2e.test', 'Your trial is ending',       '<p>Hi Bob,</p><p>Your trial ends in 3 days.</p>', 'trial', 'mid_m_b1', 0, unixepoch() * 1000 - 7200000, unixepoch() * 1000 - 7200000),
  ('e_m_b2', 'p_bob',   'marketing@e2e.test', 'Re: Your trial is ending',   '<p>I want to upgrade.</p><blockquote>On date, Bob wrote: trial</blockquote>', 'upgrade', 'mid_m_b2', 0, unixepoch() * 1000 - 3600000, unixepoch() * 1000 - 3600000),
  ('e_s_a1', 'p_alice', 'support@e2e.test',   'Help with login',             '<p>I can''t log in.</p>',                          'login', 'mid_s_a1', 0, unixepoch() * 1000 - 3600000, unixepoch() * 1000 - 3600000),
  ('e_s_a2', 'p_alice', 'support@e2e.test',   'Re: Help with login',         '<p>Tried that, still broken.</p>',                 'still', 'mid_s_a2', 0, unixepoch() * 1000 - 1800000, unixepoch() * 1000 - 1800000),
  ('e_s_b1', 'p_bob',   'support@e2e.test',   'Billing question',            '<p>What''s this charge?</p>',                      'charge', 'mid_s_b1', 0, unixepoch() * 1000 - 7200000, unixepoch() * 1000 - 7200000),
  ('e_s_b2', 'p_bob',   'support@e2e.test',   'Re: Billing question',        '<p>Thanks, that clears it up.</p>',                'clears', 'mid_s_b2', 0, unixepoch() * 1000 - 3600000, unixepoch() * 1000 - 3600000);
```

**Note:** Column names (`displayMode`, `bodyHtml`, `receivedAt`, `isRead`) must match the Drizzle schema at `worker/src/db/schema.ts`. If a column name differs, adjust this SQL rather than the schema. If the `emails` table requires a `readAt` or similar column not listed here, check the schema and add it. Run `yarn db:studio:dev` to inspect columns if unsure.

- [ ] **Step 2: Smoke-check the SQL against the live schema**

In one terminal: `yarn dev:e2e`.
In another:

```bash
wrangler d1 execute saasmail-db --local --file=seeds/e2e.sql
```

Expected: no errors. If a column name mismatch errors, open `worker/src/db/schema.ts`, identify the actual column name, update `seeds/e2e.sql`, and re-run.

Verify data landed:

```bash
wrangler d1 execute saasmail-db --local --command="SELECT email, displayMode FROM sender_identities"
```

Expected: two rows — `marketing@e2e.test|thread`, `support@e2e.test|chat`.

Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add seeds/e2e.sql
git commit -m "chore(e2e): add minimal seed SQL for inboxes, people, emails"
```

---

## Task 4: Write `e2e/support/reset-db.ts`

**Files:**

- Create: `e2e/support/reset-db.ts`

- [ ] **Step 1: Create the reset helper**

```ts
// e2e/support/reset-db.ts
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Full reset: drop local D1 state, re-apply migrations, seed SQL.
 * Only safe to call BEFORE the dev server is running (else miniflare holds file locks).
 * Used by globalSetup.
 */
export function wipeAndSeed(): void {
  // Delete the local miniflare D1 state. Matches `wrangler dev --local` default location.
  execSync(`rm -rf .wrangler/state/v3/d1/miniflare-D1DatabaseObject`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  execSync(`wrangler d1 migrations apply saasmail-db --local`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  execSync(`wrangler d1 execute saasmail-db --local --file=seeds/e2e.sql`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

/**
 * Soft reset: runs the DELETE + re-INSERT block in seeds/e2e.sql against the
 * live miniflare instance by executing the same seed file. Safe to call while
 * the dev server is running because `wrangler d1 execute --local` reads the
 * same SQLite file under a shared journal mode.
 * Used by each spec file's beforeAll.
 */
export function truncateAndReseed(): void {
  execSync(`wrangler d1 execute saasmail-db --local --file=seeds/e2e.sql`, {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add e2e/support/reset-db.ts
git commit -m "feat(e2e): add DB wipe/seed helpers"
```

---

## Task 5: Write `e2e/support/login.ts`

**Files:**

- Create: `e2e/support/login.ts`

This module handles user creation and login through the real HTTP endpoints. It's called from `globalSetup` to produce the admin storageState and to seed the `member@e2e.test` user.

- [ ] **Step 1: Create the login helper**

```ts
// e2e/support/login.ts
import type { APIRequestContext } from "@playwright/test";

export const ADMIN = {
  name: "E2E Admin",
  email: "admin@e2e.test",
  password: "e2e-admin-pw",
} as const;

export const MEMBER = {
  name: "E2E Member",
  email: "member@e2e.test",
  password: "e2e-member-pw",
} as const;

export const BASE_URL = "http://localhost:8788";

/**
 * Creates the first admin user via /api/setup. Only works when the DB has no users.
 */
export async function createAdmin(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${BASE_URL}/api/setup`, {
    data: { name: ADMIN.name, email: ADMIN.email, password: ADMIN.password },
  });
  if (!res.ok()) {
    throw new Error(`createAdmin failed: ${res.status()} ${await res.text()}`);
  }
}

/**
 * Logs in via BetterAuth and returns the APIRequestContext (cookies set on it).
 */
export async function loginViaApi(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const res = await request.post(`${BASE_URL}/api/auth/sign-in/email`, {
    data: { email, password },
  });
  if (!res.ok()) {
    throw new Error(`loginViaApi failed: ${res.status()} ${await res.text()}`);
  }
}

/**
 * Creates an invite for `email` with given role and allowed inbox addresses,
 * then completes signup through the invite-accept endpoint. Leaves the request
 * context with the invitee's cookies.
 */
export async function createAndAcceptInvite(
  adminRequest: APIRequestContext,
  inviteeRequest: APIRequestContext,
  params: {
    email: string;
    password: string;
    name: string;
    role: "admin" | "member";
    inboxEmails: string[];
  },
): Promise<void> {
  const createRes = await adminRequest.post(`${BASE_URL}/api/invites`, {
    data: {
      email: params.email,
      role: params.role,
      inboxEmails: params.inboxEmails,
    },
  });
  if (!createRes.ok()) {
    throw new Error(
      `create invite failed: ${createRes.status()} ${await createRes.text()}`,
    );
  }
  const { token } = (await createRes.json()) as { token: string };

  const acceptRes = await inviteeRequest.post(
    `${BASE_URL}/api/invites/accept`,
    {
      data: { token, name: params.name, password: params.password },
    },
  );
  if (!acceptRes.ok()) {
    throw new Error(
      `accept invite failed: ${acceptRes.status()} ${await acceptRes.text()}`,
    );
  }
}
```

**Note:** Endpoint paths are best-effort from the exploration (`/api/setup`, `/api/auth/sign-in/email`, `/api/invites`, `/api/invites/accept`). Before running, verify each against `worker/src/routers/setup-router.ts`, `worker/src/auth/index.ts`, and `worker/src/routers/invites-router.ts`. Adjust paths and request body shapes to match. If the invites router expects different field names (e.g., `allowedInboxes` vs `inboxEmails`), update the helper.

- [ ] **Step 2: Commit**

```bash
git add e2e/support/login.ts
git commit -m "feat(e2e): add HTTP login helpers (setup, sign-in, invite)"
```

---

## Task 6: Write `e2e/global-setup.ts` and `e2e/global-teardown.ts`

**Files:**

- Create: `e2e/global-setup.ts`
- Create: `e2e/global-teardown.ts`

- [ ] **Step 1: Create global-setup.ts**

```ts
// e2e/global-setup.ts
import { request } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { wipeAndSeed } from "./support/reset-db";
import {
  BASE_URL,
  ADMIN,
  MEMBER,
  createAdmin,
  loginViaApi,
  createAndAcceptInvite,
} from "./support/login";

const AUTH_DIR = resolve(__dirname, ".auth");

export default async function globalSetup(): Promise<void> {
  // 1. Fresh DB. MUST happen before the webServer starts.
  //    Playwright runs globalSetup BEFORE webServer by default.
  wipeAndSeed();

  mkdirSync(AUTH_DIR, { recursive: true });

  // 2. Wait for the dev server to be up. Playwright's webServer handles
  //    port-waiting for us; but globalSetup runs FIRST, so we also need to
  //    wait here. Poll /api/health.
  await waitForServer();

  // 3. Create admin via setup API.
  const adminCtx = await request.newContext();
  await createAdmin(adminCtx);

  // 4. Log admin in; save storageState.
  await loginViaApi(adminCtx, ADMIN.email, ADMIN.password);
  await adminCtx.storageState({ path: resolve(AUTH_DIR, "admin.json") });

  // 5. Create seeded member via invite flow. No inbox assignments.
  const memberCtx = await request.newContext();
  await createAndAcceptInvite(adminCtx, memberCtx, {
    email: MEMBER.email,
    password: MEMBER.password,
    name: MEMBER.name,
    role: "member",
    inboxEmails: [],
  });
  await memberCtx.storageState({ path: resolve(AUTH_DIR, "member.json") });

  await adminCtx.dispose();
  await memberCtx.dispose();
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server did not become ready at ${BASE_URL}/api/health`);
}
```

- [ ] **Step 2: Create global-teardown.ts**

```ts
// e2e/global-teardown.ts
// No-op today. Keep the file so the Playwright config has a place to wire
// future cleanup (e.g., leaving the DB in a known state).
export default async function globalTeardown(): Promise<void> {
  return;
}
```

**Important ordering note:** Playwright runs `globalSetup` BEFORE the `webServer` has finished starting if `webServer.reuseExistingServer` is false, but AFTER spawning. The `waitForServer()` poll handles both cases. If you hit "no such file" when wiping state while webServer is running, move `wipeAndSeed()` into a pre-script that runs before `yarn test:e2e` (see Task 8 for the fallback).

- [ ] **Step 3: Commit**

```bash
git add e2e/global-setup.ts e2e/global-teardown.ts
git commit -m "feat(e2e): add globalSetup (wipe + seed + admin + member) and teardown"
```

---

## Task 7: Write `playwright.config.ts`

**Files:**

- Create: `playwright.config.ts`

- [ ] **Step 1: Create playwright.config.ts**

```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const BASE_URL = "http://localhost:8788";

export default defineConfig({
  testDir: "./e2e/specs",
  globalSetup: require.resolve("./e2e/global-setup"),
  globalTeardown: require.resolve("./e2e/global-teardown"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    storageState: resolve(__dirname, "e2e/.auth/admin.json"),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "yarn dev:e2e",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
```

- [ ] **Step 2: Verify config parses**

Run:

```bash
yarn playwright test --list
```

Expected: Playwright parses the config. Output will say "no tests found" (since we haven't written specs yet) or list 0 tests. No config errors.

- [ ] **Step 3: Commit**

```bash
git add playwright.config.ts
git commit -m "feat(e2e): add playwright.config.ts"
```

---

## Task 8: Write `e2e/fixtures/test.ts`

**Files:**

- Create: `e2e/fixtures/test.ts`

- [ ] **Step 1: Create the extended test fixture**

```ts
// e2e/fixtures/test.ts
import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { customAlphabet } from "nanoid";
import { BASE_URL } from "../support/login";

const nano = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

type Fixtures = {
  uniqueName: (prefix: string) => string;
  api: APIRequestContext;
};

export const test = base.extend<Fixtures>({
  uniqueName: async ({}, use, testInfo) => {
    const slug = testInfo.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 24);
    use((prefix) => `${prefix}-${slug}-${nano()}`);
  },
  api: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: "e2e/.auth/admin.json",
    });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect };
```

- [ ] **Step 2: Verify nanoid is installed**

`nanoid` is already a runtime dep (from earlier read of package.json). Confirm with:

```bash
yarn list --pattern nanoid
```

Expected: nanoid listed. If missing, `yarn add -D nanoid`.

- [ ] **Step 3: Commit**

```bash
git add e2e/fixtures/test.ts
git commit -m "feat(e2e): extend Playwright test with uniqueName and api fixtures"
```

---

## Task 9: Write `e2e/support/seed.ts`

**Files:**

- Create: `e2e/support/seed.ts`

Programmatic helpers that call app routers via the pre-authed admin `api` fixture. Each helper returns the created resource's id so tests can chain operations.

- [ ] **Step 1: Create the seed helpers**

```ts
// e2e/support/seed.ts
import type { APIRequestContext } from "@playwright/test";

async function expectOk(
  res: Awaited<ReturnType<APIRequestContext["post"]>>,
  label: string,
) {
  if (!res.ok())
    throw new Error(`${label} failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

export async function createInbox(
  api: APIRequestContext,
  params: {
    email: string;
    displayName: string;
    displayMode: "thread" | "chat";
  },
) {
  const res = await api.post("/api/admin/inboxes", { data: params });
  return expectOk(res, "createInbox");
}

export async function deleteInbox(api: APIRequestContext, email: string) {
  const res = await api.delete(
    `/api/admin/inboxes/${encodeURIComponent(email)}`,
  );
  if (!res.ok()) throw new Error(`deleteInbox: ${res.status()}`);
}

export async function createTemplate(
  api: APIRequestContext,
  params: {
    name: string;
    subject: string;
    bodyHtml: string;
    fromAddress: string;
  },
) {
  const res = await api.post("/api/templates", { data: params });
  return expectOk(res, "createTemplate");
}

export async function createSequence(
  api: APIRequestContext,
  params: {
    name: string;
    steps: Array<{ templateSlug: string; delayDays: number }>;
  },
) {
  const res = await api.post("/api/sequences", { data: params });
  return expectOk(res, "createSequence");
}

export async function enrollContact(
  api: APIRequestContext,
  params: { sequenceId: string; personId: string; fromAddress: string },
) {
  const res = await api.post(
    `/api/sequences/${params.sequenceId}/enrollments`,
    { data: { personId: params.personId, fromAddress: params.fromAddress } },
  );
  return expectOk(res, "enrollContact");
}

export async function createApiKey(api: APIRequestContext, name: string) {
  const res = await api.post("/api/api-keys", { data: { name } });
  return expectOk(res, "createApiKey");
}

export async function createInvite(
  api: APIRequestContext,
  params: { email: string; role: "admin" | "member"; inboxEmails: string[] },
) {
  const res = await api.post("/api/invites", { data: params });
  return expectOk(res, "createInvite");
}
```

**Note:** Exact endpoint paths and field names are best-effort from the router filenames. Before any spec using a helper runs, verify it matches the Zod schema in the corresponding `worker/src/routers/*.ts`. Update paths/params if the schema differs (e.g., `allowedInboxes` vs `inboxEmails`). Adjusting a helper is preferred over changing the router.

- [ ] **Step 2: Commit**

```bash
git add e2e/support/seed.ts
git commit -m "feat(e2e): add programmatic API seed helpers"
```

---

## Task 10: Write `e2e/support/selectors.ts`

**Files:**

- Create: `e2e/support/selectors.ts`

- [ ] **Step 1: Create selectors constants**

```ts
// e2e/support/selectors.ts
// Centralized data-testid strings used by specs. Only add entries here when
// a role/label/text selector is genuinely ambiguous — prefer built-in
// selectors where possible. When adding an entry, also add the matching
// data-testid to the component.

export const TEST_IDS = {
  // Inbox admin page
  inboxRow: "inbox-row",
  inboxCreateButton: "inbox-create-button",
  inboxModeToggle: "inbox-mode-toggle",

  // Sequences
  sequenceRow: "sequence-row",
  sequenceStepRow: "sequence-step-row",

  // Display
  chatBubble: "chat-bubble",
  threadMessage: "thread-message",

  // Compose
  composeSendButton: "compose-send-button",
  composeBody: "compose-body",

  // API keys
  apiKeyRow: "api-key-row",
  apiKeyRevealed: "api-key-revealed",
} as const;
```

- [ ] **Step 2: Commit**

```bash
git add e2e/support/selectors.ts
git commit -m "feat(e2e): add shared selectors constants"
```

---

## Task 11: Write `auth.spec.ts`

**Files:**

- Create: `e2e/specs/auth.spec.ts`
- Read: `src/pages/OnboardingPage.tsx`, `src/pages/LoginPage.tsx`

- [ ] **Step 1: Read the UI files**

Open `src/pages/OnboardingPage.tsx` and `src/pages/LoginPage.tsx`. Note the exact label text for the name, email, and password inputs and the submit button. These drive the locator choices below.

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/auth.spec.ts
import { test, expect } from "../fixtures/test";
import { wipeAndSeed } from "../support/reset-db";

// No storageState — this spec drives setup + login UIs.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe.serial("auth flow", () => {
  test.beforeAll(async () => {
    // Fully reset: drop users so the setup wizard appears.
    wipeAndSeed();
  });

  test("setup wizard creates admin and lands on inbox", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/onboarding$/);

    await page.getByLabel(/name/i).fill("Admin One");
    await page.getByLabel(/email/i).fill("admin@e2e.test");
    await page.getByLabel(/password/i).fill("e2e-admin-pw");
    await page
      .getByRole("button", { name: /create|sign up|get started/i })
      .click();

    // After setup, BetterAuth auto-signs-in → redirect off /onboarding.
    await expect(page).not.toHaveURL(/\/onboarding/);
    await expect(
      page.getByRole("link", { name: /inboxes|people/i }),
    ).toBeVisible();
  });

  test("logout then login with correct credentials", async ({ page }) => {
    await page.goto("/");

    // Log out via user menu. Exact menu trigger depends on UI — adjust after reading LoginPage/header.
    await page.getByRole("button", { name: /account|menu|admin one/i }).click();
    await page.getByRole("menuitem", { name: /log ?out|sign ?out/i }).click();

    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel(/email/i).fill("admin@e2e.test");
    await page.getByLabel(/password/i).fill("e2e-admin-pw");
    await page.getByRole("button", { name: /log ?in|sign ?in/i }).click();

    await expect(page).not.toHaveURL(/\/login/);
  });

  test("login with wrong password shows error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@e2e.test");
    await page.getByLabel(/password/i).fill("wrong-password");
    await page.getByRole("button", { name: /log ?in|sign ?in/i }).click();

    await expect(page.getByText(/invalid|incorrect|wrong/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});
```

- [ ] **Step 3: Run the spec**

```bash
yarn test:e2e e2e/specs/auth.spec.ts
```

Expected: tests pass. If a locator misses, open `playwright-report/` (`yarn playwright show-report`) to see screenshots/DOM. Adjust the label or role pattern (not the UI) to match what the component actually renders. If the UI has no obvious selector, add a narrow `data-testid` to the component and use `page.getByTestId(TEST_IDS.x)`.

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/auth.spec.ts src/pages/OnboardingPage.tsx src/pages/LoginPage.tsx
git commit -m "test(e2e): cover setup wizard and login UI"
```

(Only add UI files if you added data-testids to them.)

---

## Task 12: Write `inboxes.spec.ts`

**Files:**

- Create: `e2e/specs/inboxes.spec.ts`
- Read: `src/pages/InboxesPage.tsx`

- [ ] **Step 1: Read InboxesPage.tsx**

Confirm: the list of inboxes, the "create inbox" trigger, how the display mode toggle works (button/select/switch), and the delete confirmation flow.

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/inboxes.spec.ts
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("inboxes CRUD", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("create inbox appears in list", async ({ page, uniqueName }) => {
    const email = uniqueName("onboarding") + "@e2e.test";
    await page.goto("/inboxes");
    await page
      .getByRole("button", { name: /add inbox|new inbox|create/i })
      .click();
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/display name/i).fill("Onboarding");
    await page.getByRole("button", { name: /create|save/i }).click();

    await expect(page.getByText(email)).toBeVisible();
  });

  test("rename display name persists after reload", async ({ page }) => {
    await page.goto("/inboxes");
    const row = page
      .getByTestId(TEST_IDS.inboxRow)
      .filter({ hasText: "marketing@e2e.test" });
    await row.getByRole("button", { name: /edit|rename/i }).click();
    await page.getByLabel(/display name/i).fill("Marketing Team");
    await page.getByRole("button", { name: /save/i }).click();

    await page.reload();
    await expect(page.getByText("Marketing Team")).toBeVisible();
  });

  test("toggle thread → chat mode persists", async ({ page }) => {
    await page.goto("/inboxes");
    const row = page
      .getByTestId(TEST_IDS.inboxRow)
      .filter({ hasText: "marketing@e2e.test" });
    await row.getByTestId(TEST_IDS.inboxModeToggle).click();
    await page.getByRole("menuitem", { name: /chat/i }).click();

    await page.reload();
    await expect(row.getByText(/chat/i)).toBeVisible();
  });

  test("assign member to inbox scopes visibility", async ({ page, api }) => {
    // Assign member to support@e2e.test via admin UI
    await page.goto("/inboxes");
    const row = page
      .getByTestId(TEST_IDS.inboxRow)
      .filter({ hasText: "support@e2e.test" });
    await row.getByRole("button", { name: /members|assign/i }).click();
    await page.getByLabel(/add user|member/i).fill("member@e2e.test");
    await page.getByRole("button", { name: /add|save/i }).click();

    // Verify scoping via member API context
    const memberApi = await page.context().request;
    const memberCtx = await (
      await import("@playwright/test")
    ).request.newContext({
      baseURL: "http://localhost:8788",
      storageState: "e2e/.auth/member.json",
    });
    const res = await memberCtx.get("/api/admin/inboxes");
    expect(res.ok()).toBe(true);
    const inboxes = (await res.json()) as Array<{ email: string }>;
    expect(inboxes.map((i) => i.email)).toContain("support@e2e.test");
    expect(inboxes.map((i) => i.email)).not.toContain("marketing@e2e.test");
    await memberCtx.dispose();
  });

  test("delete inbox removes it from list", async ({ page, uniqueName }) => {
    const email = uniqueName("disposable") + "@e2e.test";
    await page.goto("/inboxes");
    await page.getByRole("button", { name: /add inbox|new inbox/i }).click();
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/display name/i).fill("Disposable");
    await page.getByRole("button", { name: /create|save/i }).click();

    const row = page.getByTestId(TEST_IDS.inboxRow).filter({ hasText: email });
    await row.getByRole("button", { name: /delete|remove/i }).click();
    await page.getByRole("button", { name: /confirm|yes|delete/i }).click();

    await expect(page.getByText(email)).not.toBeVisible();
  });
});
```

- [ ] **Step 3: Run and iterate**

```bash
yarn test:e2e e2e/specs/inboxes.spec.ts
```

Expected: tests pass. Add `data-testid` to `InboxesPage.tsx` where selectors are ambiguous — at minimum for `inbox-row`, `inbox-mode-toggle`.

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/inboxes.spec.ts src/pages/InboxesPage.tsx
git commit -m "test(e2e): cover inbox CRUD, mode toggle, member scoping"
```

---

## Task 13: Write `sequences.spec.ts`

**Files:**

- Create: `e2e/specs/sequences.spec.ts`
- Read: `src/pages/SequencesPage.tsx`, `src/pages/SequenceEditorPage.tsx`, `src/pages/SequenceDetailPage.tsx`

- [ ] **Step 1: Read the three sequence pages**

Note: the list layout, step editor UI (add/remove step, delay input), enrollment section on detail page.

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/sequences.spec.ts
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { createTemplate } from "../support/seed";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("sequences CRUD + enrollment", () => {
  test.beforeAll(async ({ request }) => {
    truncateAndReseed();
    // Create two templates needed for sequence steps.
    const api = await request.newContext({
      baseURL: "http://localhost:8788",
      storageState: "e2e/.auth/admin.json",
    });
    await createTemplate(api, {
      name: "welcome",
      subject: "Welcome",
      bodyHtml: "<p>Hello {{name}}</p>",
      fromAddress: "marketing@e2e.test",
    });
    await createTemplate(api, {
      name: "followup",
      subject: "Following up",
      bodyHtml: "<p>Checking in {{name}}</p>",
      fromAddress: "marketing@e2e.test",
    });
    await api.dispose();
  });

  test("create 3-step sequence", async ({ page, uniqueName }) => {
    const name = uniqueName("seq");
    await page.goto("/sequences");
    await page.getByRole("button", { name: /new sequence|create/i }).click();
    await page.getByLabel(/name/i).fill(name);

    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: /add step/i }).click();
    }

    const steps = page.getByTestId(TEST_IDS.sequenceStepRow);
    await expect(steps).toHaveCount(3);
    await steps
      .nth(0)
      .getByLabel(/template/i)
      .selectOption({ label: /welcome/i });
    await steps
      .nth(1)
      .getByLabel(/template/i)
      .selectOption({ label: /followup/i });
    await steps
      .nth(2)
      .getByLabel(/template/i)
      .selectOption({ label: /followup/i });
    await steps.nth(1).getByLabel(/delay/i).fill("3");
    await steps.nth(2).getByLabel(/delay/i).fill("7");

    await page.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText(name)).toBeVisible();
  });

  test("edit step delay and remove a step", async ({ page, uniqueName }) => {
    const name = uniqueName("editseq");
    await page.goto("/sequences");
    await page.getByRole("button", { name: /new sequence|create/i }).click();
    await page.getByLabel(/name/i).fill(name);
    await page.getByRole("button", { name: /add step/i }).click();
    await page.getByRole("button", { name: /add step/i }).click();
    const steps = page.getByTestId(TEST_IDS.sequenceStepRow);
    await steps
      .nth(0)
      .getByLabel(/template/i)
      .selectOption({ label: /welcome/i });
    await steps
      .nth(1)
      .getByLabel(/template/i)
      .selectOption({ label: /followup/i });
    await page.getByRole("button", { name: /save/i }).click();

    await page.getByRole("link", { name }).click();
    await page.getByRole("button", { name: /edit/i }).click();
    await steps.nth(1).getByLabel(/delay/i).fill("10");
    await steps
      .nth(1)
      .getByRole("button", { name: /remove|delete step/i })
      .click();
    await page.getByRole("button", { name: /save/i }).click();

    await expect(page.getByTestId(TEST_IDS.sequenceStepRow)).toHaveCount(1);
  });

  test("enroll contact and cancel enrollment", async ({ page, uniqueName }) => {
    const name = uniqueName("enrollseq");
    await page.goto("/sequences");
    await page.getByRole("button", { name: /new sequence|create/i }).click();
    await page.getByLabel(/name/i).fill(name);
    await page.getByRole("button", { name: /add step/i }).click();
    await page
      .getByTestId(TEST_IDS.sequenceStepRow)
      .first()
      .getByLabel(/template/i)
      .selectOption({ label: /welcome/i });
    await page.getByRole("button", { name: /save/i }).click();
    await page.getByRole("link", { name }).click();

    // Enroll alice
    await page.getByRole("button", { name: /enroll|add contact/i }).click();
    await page.getByLabel(/person|contact|email/i).fill("alice@customers.test");
    await page.getByLabel(/from/i).selectOption({ label: /marketing/i });
    await page.getByRole("button", { name: /enroll|add/i }).click();

    const enrollmentRow = page.getByText("alice@customers.test");
    await expect(enrollmentRow).toBeVisible();
    await expect(page.getByText(/enrolled|active/i)).toBeVisible();

    // Cancel
    await page.getByRole("button", { name: /cancel/i }).click();
    await page.getByRole("button", { name: /confirm|yes/i }).click();
    await expect(page.getByText(/cancelled|canceled/i)).toBeVisible();
  });

  test("delete sequence", async ({ page, uniqueName }) => {
    const name = uniqueName("delseq");
    await page.goto("/sequences");
    await page.getByRole("button", { name: /new sequence|create/i }).click();
    await page.getByLabel(/name/i).fill(name);
    await page.getByRole("button", { name: /add step/i }).click();
    await page
      .getByTestId(TEST_IDS.sequenceStepRow)
      .first()
      .getByLabel(/template/i)
      .selectOption({ label: /welcome/i });
    await page.getByRole("button", { name: /save/i }).click();

    await page.getByRole("link", { name }).click();
    await page.getByRole("button", { name: /delete sequence|delete/i }).click();
    await page.getByRole("button", { name: /confirm|yes|delete/i }).click();

    await expect(page).toHaveURL(/\/sequences$/);
    await expect(page.getByText(name)).not.toBeVisible();
  });
});
```

- [ ] **Step 3: Run and iterate**

```bash
yarn test:e2e e2e/specs/sequences.spec.ts
```

Expected: tests pass. Add test ids (`sequence-row`, `sequence-step-row`) as needed.

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/sequences.spec.ts src/pages/SequencesPage.tsx src/pages/SequenceEditorPage.tsx src/pages/SequenceDetailPage.tsx
git commit -m "test(e2e): cover sequence create, edit, enroll, cancel, delete"
```

---

## Task 14: Write `compose.spec.ts`

**Files:**

- Create: `e2e/specs/compose.spec.ts`
- Read: `src/pages/ComposeModal.tsx`, `src/pages/PersonDetail.tsx`

- [ ] **Step 1: Read the two UI files**

Note: compose trigger location (floating button, menu, inside person detail), body editor type (TipTap — needs `.locator('.ProseMirror').fill(...)` or `.type(...)` style interaction), success feedback pattern.

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/compose.spec.ts
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

test.describe.serial("compose & send", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("sends an email in DEMO_MODE, records demo_ id", async ({
    page,
    api,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /alice/i }).first().click();
    await page.getByRole("button", { name: /reply|compose/i }).click();

    // TipTap renders a contenteditable `.ProseMirror`.
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("Reply from E2E test");

    await page.getByRole("button", { name: /send/i }).click();

    await expect(page.getByText(/sent|success/i)).toBeVisible();

    // Assert backend recorded a demo_ id.
    const res = await api.get("/api/sent-emails?personId=p_alice");
    expect(res.ok()).toBe(true);
    const rows = (await res.json()) as Array<{ id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].id).toMatch(/^demo_/);
  });

  test("submit blocked with empty body", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /alice/i }).first().click();
    await page.getByRole("button", { name: /reply|compose/i }).click();

    // Leave body empty
    const sendBtn = page.getByRole("button", { name: /send/i });
    // Either the button is disabled, or clicking surfaces validation.
    if (await sendBtn.isDisabled()) {
      await expect(sendBtn).toBeDisabled();
    } else {
      await sendBtn.click();
      await expect(
        page.getByText(/required|empty|cannot be blank/i),
      ).toBeVisible();
    }
  });
});
```

**Note:** The exact GET endpoint for sent emails (`/api/sent-emails?personId=...`) is a guess. Verify against `worker/src/routers/emails-router.ts` or `worker/src/routers/send-router.ts`. If no GET-all endpoint exists, query via `/api/people/:id/sent-emails` or similar. Adjust the helper and spec together.

- [ ] **Step 3: Run and iterate**

```bash
yarn test:e2e e2e/specs/compose.spec.ts
```

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/compose.spec.ts
git commit -m "test(e2e): cover compose, send, DEMO_MODE demo_ id, empty-body guard"
```

---

## Task 15: Write `thread-display.spec.ts`

**Files:**

- Create: `e2e/specs/thread-display.spec.ts`
- Read: `src/pages/PersonDetail.tsx` (thread rendering code path)

- [ ] **Step 1: Read the thread rendering code**

Identify: how thread messages are rendered, whether subject lines appear per message or once at top, how quoted history is collapsed (detail/summary? button?).

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/thread-display.spec.ts
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("thread-mode display (marketing@)", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("renders subjects, HTML bodies, collapsible quoted history", async ({
    page,
  }) => {
    await page.goto("/");
    // Navigate to marketing inbox view, then alice
    await page.getByRole("link", { name: /marketing/i }).click();
    await page.getByRole("link", { name: /alice/i }).click();

    // Subject lines are visible
    await expect(page.getByText("Welcome to our product")).toBeVisible();
    await expect(page.getByText("Re: Welcome to our product")).toBeVisible();

    // HTML rendered (not escaped angle brackets)
    const threadMessages = page.getByTestId(TEST_IDS.threadMessage);
    await expect(threadMessages).toHaveCount(2);
    await expect(threadMessages.first()).toContainText("Welcome aboard!");

    // Quoted history collapsed by default; expand trigger exists
    const quoteToggle = page.getByRole("button", {
      name: /show quoted|view history|more/i,
    });
    if (await quoteToggle.count()) {
      await expect(quoteToggle.first()).toBeVisible();
    }

    // Reply composer present
    await expect(
      page.getByRole("button", { name: /reply|compose/i }),
    ).toBeVisible();
  });
});
```

- [ ] **Step 3: Run and iterate**

```bash
yarn test:e2e e2e/specs/thread-display.spec.ts
```

Add `data-testid="thread-message"` to the thread message component if needed.

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/thread-display.spec.ts src/pages/PersonDetail.tsx
git commit -m "test(e2e): cover thread-mode display for marketing@ inbox"
```

---

## Task 16: Write `chat-display.spec.ts`

**Files:**

- Create: `e2e/specs/chat-display.spec.ts`
- Read: `src/pages/PersonDetail.tsx` (chat rendering branch)

- [ ] **Step 1: Read the chat rendering branch**

Confirm: chat bubbles are separate DOM (per-message bubble), no subjects shown, composer is inline not modal.

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/chat-display.spec.ts
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("chat-mode display (support@)", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("renders bubbles without subjects and with inline composer", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /support/i }).click();
    await page.getByRole("link", { name: /alice/i }).click();

    const bubbles = page.getByTestId(TEST_IDS.chatBubble);
    await expect(bubbles).toHaveCount(2);
    await expect(bubbles.first()).toContainText("I can't log in.");

    // No subject-line text surfaced in chat mode
    await expect(
      page.getByText("Help with login", { exact: true }),
    ).not.toBeVisible();

    // Inline composer: a contenteditable or text input is visible at the bottom,
    // not a modal with a separate "Compose" button.
    const composer = page
      .locator(".ProseMirror")
      .or(page.getByPlaceholder(/reply|message/i));
    await expect(composer.first()).toBeVisible();
  });
});
```

- [ ] **Step 3: Run and iterate**

```bash
yarn test:e2e e2e/specs/chat-display.spec.ts
```

Add `data-testid="chat-bubble"` to the bubble component if needed.

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/chat-display.spec.ts src/pages/PersonDetail.tsx
git commit -m "test(e2e): cover chat-mode display for support@ inbox"
```

---

## Task 17: Write `templates.spec.ts`

**Files:**

- Create: `e2e/specs/templates.spec.ts`
- Read: `src/pages/TemplatesPage.tsx`, `src/pages/TemplateEditorPage.tsx`

- [ ] **Step 1: Read the template pages**

Note: CodeMirror usage (HTML editor), how preview toggles on, how variables are extracted.

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/templates.spec.ts
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

test.describe.serial("templates CRUD", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("create template with vars and preview interpolation", async ({
    page,
    uniqueName,
  }) => {
    const name = uniqueName("tpl");
    await page.goto("/templates");
    await page.getByRole("button", { name: /new template|create/i }).click();
    await page.getByLabel(/name/i).fill(name);
    await page.getByLabel(/subject/i).fill("Hi {{name}}");

    // CodeMirror renders inside .cm-content
    await page.locator(".cm-content").click();
    await page.keyboard.type("<p>Hello {{name}}, enjoy {{product}}!</p>");

    await page.getByRole("button", { name: /save/i }).click();

    // Preview tab
    await page.getByRole("tab", { name: /preview/i }).click();
    await page.getByLabel(/name/i).fill("Alice");
    await page.getByLabel(/product/i).fill("saasmail");

    await expect(page.getByText("Hello Alice, enjoy saasmail!")).toBeVisible();
  });

  test("edit HTML persists after reload", async ({ page, uniqueName }) => {
    const name = uniqueName("edit-tpl");
    await page.goto("/templates");
    await page.getByRole("button", { name: /new template|create/i }).click();
    await page.getByLabel(/name/i).fill(name);
    await page.getByLabel(/subject/i).fill("S");
    await page.locator(".cm-content").click();
    await page.keyboard.type("<p>v1</p>");
    await page.getByRole("button", { name: /save/i }).click();

    await page.getByRole("link", { name }).click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await page.keyboard.type("<p>v2</p>");
    await page.getByRole("button", { name: /save/i }).click();

    await page.reload();
    await expect(page.locator(".cm-content")).toContainText("v2");
  });

  test("delete template", async ({ page, uniqueName }) => {
    const name = uniqueName("del-tpl");
    await page.goto("/templates");
    await page.getByRole("button", { name: /new template|create/i }).click();
    await page.getByLabel(/name/i).fill(name);
    await page.getByLabel(/subject/i).fill("s");
    await page.locator(".cm-content").click();
    await page.keyboard.type("<p>x</p>");
    await page.getByRole("button", { name: /save/i }).click();

    await page.getByRole("link", { name }).click();
    await page.getByRole("button", { name: /delete/i }).click();
    await page.getByRole("button", { name: /confirm|yes/i }).click();

    await expect(page).toHaveURL(/\/templates$/);
    await expect(page.getByText(name)).not.toBeVisible();
  });
});
```

- [ ] **Step 3: Run and iterate**

```bash
yarn test:e2e e2e/specs/templates.spec.ts
```

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/templates.spec.ts
git commit -m "test(e2e): cover template CRUD + preview interpolation"
```

---

## Task 18: Write `api-keys.spec.ts`

**Files:**

- Create: `e2e/specs/api-keys.spec.ts`
- Read: `src/pages/ApiKeysPage.tsx`

- [ ] **Step 1: Read ApiKeysPage.tsx**

Note: how the full `sk_…` key is displayed on creation (likely a one-time modal), revoke trigger, mask format.

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/api-keys.spec.ts
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("API keys", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("create key, use it to hit authed endpoint, revoke it", async ({
    page,
    playwright,
    uniqueName,
  }) => {
    const name = uniqueName("key");
    await page.goto("/api-keys");
    await page.getByRole("button", { name: /new key|create/i }).click();
    await page.getByLabel(/name/i).fill(name);
    await page.getByRole("button", { name: /create/i }).click();

    const revealed = page.getByTestId(TEST_IDS.apiKeyRevealed);
    await expect(revealed).toBeVisible();
    const keyValue = (await revealed.textContent())?.trim() || "";
    expect(keyValue).toMatch(/^sk_/);
    await page.getByRole("button", { name: /close|done/i }).click();

    // Use the key via a raw request context (no cookies)
    const apiCtx = await playwright.request.newContext({
      baseURL: "http://localhost:8788",
      extraHTTPHeaders: { Authorization: `Bearer ${keyValue}` },
    });
    const okRes = await apiCtx.get("/api/v1/emails?limit=1");
    expect(okRes.ok()).toBe(true);

    // Revoke via UI
    const row = page.getByTestId(TEST_IDS.apiKeyRow).filter({ hasText: name });
    await row.getByRole("button", { name: /revoke|delete/i }).click();
    await page.getByRole("button", { name: /confirm|yes/i }).click();

    // Subsequent call is 401
    const revokedRes = await apiCtx.get("/api/v1/emails?limit=1");
    expect(revokedRes.status()).toBe(401);
    await apiCtx.dispose();
  });

  test("key list shows masked prefix", async ({ page, uniqueName }) => {
    const name = uniqueName("masked");
    await page.goto("/api-keys");
    await page.getByRole("button", { name: /new key|create/i }).click();
    await page.getByLabel(/name/i).fill(name);
    await page.getByRole("button", { name: /create/i }).click();
    await page.getByRole("button", { name: /close|done/i }).click();

    const row = page.getByTestId(TEST_IDS.apiKeyRow).filter({ hasText: name });
    // A masked prefix like `sk_abc…` or `sk_****` should be visible; full key must NOT be.
    await expect(row.getByText(/sk_[a-z0-9]{2,}/i)).toBeVisible();
  });
});
```

**Note:** Verify `/api/v1/emails` is the authed programmatic endpoint. If the API key namespace is different (e.g., `/api/v1/people`, `/api/send`), substitute. Check `worker/src/middleware/` for API-key auth and pick a GET endpoint that accepts API-key auth and returns 200 with no extra setup.

- [ ] **Step 3: Run and iterate**

```bash
yarn test:e2e e2e/specs/api-keys.spec.ts
```

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/api-keys.spec.ts src/pages/ApiKeysPage.tsx
git commit -m "test(e2e): cover API key create/use/revoke and mask"
```

---

## Task 19: Write `invites.spec.ts`

**Files:**

- Create: `e2e/specs/invites.spec.ts`
- Read: `src/pages/AdminUsersPage.tsx`, `src/pages/InviteAcceptPage.tsx`

- [ ] **Step 1: Read the invite pages**

Note: how admin generates the invite URL (copy button + toast? displayed inline?), invite accept form fields, redirect after accept.

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/invites.spec.ts
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { createInvite } from "../support/seed";

test.describe.serial("invite accept flow", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("invitee accepts via fresh context, sees only assigned inbox", async ({
    api,
    browser,
  }) => {
    // Admin creates invite for invitee@ scoped to support@ only.
    const invite = (await createInvite(api, {
      email: "invitee@e2e.test",
      role: "member",
      inboxEmails: ["support@e2e.test"],
    })) as { token: string };

    // Open fresh context — no storageState.
    const ctx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await ctx.newPage();
    await page.goto(`/invite/${invite.token}`);

    await page.getByLabel(/name/i).fill("Invitee One");
    await page.getByLabel(/password/i).fill("invitee-pw-123");
    await page.getByRole("button", { name: /accept|sign up|create/i }).click();

    // Redirected to authed landing page
    await expect(page).not.toHaveURL(/\/invite/);

    // Visit inboxes: only support@ visible (or navigation to marketing@ blocked).
    // Admins land on /inboxes; members may land elsewhere. Use the API for a deterministic check.
    const memberApi = ctx.request;
    const res = await memberApi.get("/api/admin/inboxes");
    // Members may get 403 on admin endpoint — try scoped endpoint instead.
    if (res.status() === 403) {
      const mineRes = await memberApi.get("/api/inboxes");
      expect(mineRes.ok()).toBe(true);
      const inboxes = (await mineRes.json()) as Array<{ email: string }>;
      expect(inboxes.map((i) => i.email)).toContain("support@e2e.test");
      expect(inboxes.map((i) => i.email)).not.toContain("marketing@e2e.test");
    } else {
      expect(res.ok()).toBe(true);
      const inboxes = (await res.json()) as Array<{ email: string }>;
      expect(inboxes.map((i) => i.email)).toContain("support@e2e.test");
      expect(inboxes.map((i) => i.email)).not.toContain("marketing@e2e.test");
    }
    await ctx.close();
  });
});
```

**Note:** The invite URL pattern (`/invite/:token`) is a best guess — verify against `src/App.tsx` router. The scoped-inbox endpoint for a non-admin member also needs verification; prefer a single well-scoped endpoint that works for both roles if one exists.

- [ ] **Step 3: Run and iterate**

```bash
yarn test:e2e e2e/specs/invites.spec.ts
```

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/invites.spec.ts src/pages/InviteAcceptPage.tsx src/pages/AdminUsersPage.tsx
git commit -m "test(e2e): cover invite accept + member inbox scoping"
```

---

## Task 20: Run the entire suite end-to-end

- [ ] **Step 1: Run the full suite**

```bash
yarn test:e2e
```

Expected: all nine specs pass sequentially in Chromium. If any test is flaky, do NOT add `waitForTimeout`. Instead identify the missing `expect` that should be awaited and replace explicit waits with `expect(...).toBeVisible()` / `expect.poll(...)` assertions.

- [ ] **Step 2: If any spec fails, iterate**

```bash
yarn test:e2e e2e/specs/<failing>.spec.ts --headed
# or
yarn test:e2e:ui
```

Fix locators or minimally add `data-testid`s as needed. Commit fixes per-spec so history stays clean.

- [ ] **Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "test(e2e): stabilize full suite"
```

(Skip if no changes.)

---

## Task 21: Update README

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add an E2E subsection to Local Development**

Insert this subsection under the `## Local Development` heading, after the existing blocks:

````markdown
### End-to-end tests

Playwright drives the UI against a local `vite dev` running in demo mode.

```bash
# Install Playwright browsers (first run only)
yarn playwright install chromium

# Run the full E2E suite
yarn test:e2e

# Interactive runner
yarn test:e2e:ui
```

The E2E suite **wipes and re-seeds the local D1 database** (`.wrangler/state/v3/d1/`) every time it runs. If you have hand-seeded dev data you want to keep, re-run `yarn db:seed:dev` after the E2E suite finishes.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document yarn test:e2e workflow and DB-wipe caveat"
```

---

## Task 22: Add CI workflow

**Files:**

- Create: `.github/workflows/e2e.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: e2e

on:
  pull_request:
  push:
    branches: [main]

jobs:
  playwright:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: yarn

      - name: Install deps
        run: yarn install --frozen-lockfile

      - name: Cache Playwright browsers
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: ${{ runner.os }}-playwright-${{ hashFiles('yarn.lock') }}
          restore-keys: |
            ${{ runner.os }}-playwright-

      - name: Install Chromium
        run: yarn playwright install --with-deps chromium

      - name: Run E2E suite
        run: yarn test:e2e
        env:
          CI: "true"

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/e2e.yml
git commit -m "ci: run Playwright E2E suite on PR and push to main"
```

- [ ] **Step 3: Push branch and verify the workflow runs**

```bash
git push -u origin HEAD
```

Open the PR on GitHub and verify the `e2e` check runs. If it fails, download the `playwright-report` artifact from the Actions UI, inspect, fix, push again.

---

## Self-review notes

- **Spec coverage:** All 9 spec files from the design doc have a corresponding task (Tasks 11–19). Infrastructure (Tasks 1–10), docs (Task 21), and CI (Task 22) round out the full plan.
- **Non-goals honored:** No visual regression, no cross-browser, no accessibility, no mobile viewport, no real outbound send.
- **Deviations from spec** are documented up top (persist dir isolation dropped, password hash script dropped) with rationale.
- **Endpoint paths in helpers** are best-effort and flagged for verification against the actual routers before first run. This is intentional — the spec authors don't have deep knowledge of router paths and should verify-then-adjust rather than treat the plan as infallible.
- **`data-testid` additions** are kept minimal and per-spec. Agents should only add ids when role/label/text selectors are genuinely ambiguous.
