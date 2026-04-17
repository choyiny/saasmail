# Inbox Display Mode (Chat vs Thread) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-controlled per-inbox `displayMode` of `thread` (current behavior) or `chat` (iMessage-style bubbles + always-visible plain-text quick reply) that changes how that inbox's section renders inside `PersonDetail`.

**Architecture:** Extend the existing `sender_identities` table with a `displayMode` column (DB enum + check constraint). Surface it on `GET /admin/inboxes` and `PATCH /admin/inboxes/{email}`. Augment `GET /api/emails/by-person/{personId}` to also return per-inbox metadata (`{ emails, inboxes }`), so the frontend knows each section's mode without a second admin-only request. In `PersonDetail`, each per-inbox `<section>` chooses between a new `ThreadInboxSection` (extracted as-is from current code) or a new `ChatInboxSection` (5 visible bubbles, "Show earlier" pagination, attachments as chips, "View original" → existing `EmailHtmlModal`, plus a pinned `ChatQuickReply` plain-text composer).

**Tech Stack:** TypeScript, Drizzle ORM (SQLite/D1), Hono + `@hono/zod-openapi`, React 18 + Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-17-inbox-display-mode-chat-vs-thread-design.md`

**Conventions:**

- Use `yarn` (not npm) for everything (per `CLAUDE.md`).
- After each phase, run `yarn tsc --noEmit` and `yarn test` (where tests are touched). Don't proceed to the next phase if either fails.
- Commit at the end of each task with the suggested message.
- Never use `--no-verify`; if the pre-commit hook (Prettier/lint-staged) reformats files, that is expected and intentional — let it run, then re-verify the working tree is clean.

---

## File Structure

**Backend**

| File                                                | Responsibility                                                                                                | Status   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| `worker/src/db/sender-identities.schema.ts`         | Add `displayMode` column, make `displayName` nullable                                                         | Modified |
| `migrations/0017_<drizzle-name>.sql`                | Generated migration                                                                                           | Created  |
| `worker/src/routers/admin-inboxes-router.ts`        | GET returns `displayMode`; PATCH accepts partial body and preserves the row when only the mode is non-default | Modified |
| `worker/src/routers/emails-router.ts`               | `GET /api/emails/by-person/{personId}` returns `{ emails, inboxes }` instead of `Email[]`                     | Modified |
| `worker/src/__tests__/admin-inboxes-router.test.ts` | New cases for `displayMode`                                                                                   | Modified |
| `worker/src/__tests__/emails-router.test.ts`        | Update existing cases for new shape; add `inboxes` assertions                                                 | Modified |

**Frontend**

| File                                    | Responsibility                                                                                                                   | Status   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `src/lib/api.ts`                        | Types for `displayMode`, new helper `updateInboxSettings`, `fetchPersonEmails` returns `{ emails, inboxes }`                     | Modified |
| `src/components/AdminInboxTable.tsx`    | Segmented Mode control next to display-name input                                                                                | Modified |
| `src/pages/PersonDetail.tsx`            | Build `inboxModeMap`, route each section to Thread or Chat renderer; only Thread sections trigger the page-level `ReplyComposer` | Modified |
| `src/components/ThreadInboxSection.tsx` | Extracted from current `PersonDetail` per-section JSX, no behavioral change                                                      | Created  |
| `src/components/ChatQuickReply.tsx`     | Auto-growing plain-text textarea, wraps to HTML and calls `replyToEmail`                                                         | Created  |
| `src/components/ChatInboxSection.tsx`   | iMessage-style bubble layout, "Show earlier" pagination, embedded `ChatQuickReply`                                               | Created  |

---

## Phase 1 — Backend schema & migration

### Task 1: Update `sender-identities` schema and generate migration

**Files:**

- Modify: `worker/src/db/sender-identities.schema.ts`
- Create: `migrations/0017_<drizzle-generated>.sql` (filename produced by `drizzle-kit generate`)

- [ ] **Step 1: Edit the schema**

Replace the entire file contents:

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const senderIdentities = sqliteTable("sender_identities", {
  email: text("email").primaryKey(),
  displayName: text("display_name"),
  displayMode: text("display_mode", { enum: ["thread", "chat"] })
    .notNull()
    .default("thread"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

> Drizzle's `enum: [...]` config gives compile-time type safety for the values; rely on the application layer (Zod schemas + handler logic) to enforce the constraint at the API boundary. A SQL `CHECK` constraint is intentionally omitted because Drizzle's SQLite driver does not generate one from the `enum` config and we want a single migration without hand-editing.

- [ ] **Step 2: Generate the migration**

Run: `yarn db:generate`
Expected: a new file `migrations/0017_<two-word-name>.sql` is created. Inspect it — it should contain (1) `ALTER TABLE sender_identities ADD COLUMN display_mode TEXT DEFAULT 'thread' NOT NULL;` and (2) the SQLite table-rebuild dance for `display_name` (Drizzle emits `__new_sender_identities`, copy-data, drop, rename).

- [ ] **Step 3: Apply the migration locally**

Run: `yarn db:migrate:dev`
Expected: migration applies cleanly, no errors.

- [ ] **Step 4: Type-check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add worker/src/db/sender-identities.schema.ts migrations/0017_*.sql migrations/meta
git commit -m "feat(db): add display_mode to sender_identities, allow nullable display_name"
```

---

## Phase 2 — Admin inboxes router

### Task 2: Update `GET /admin/inboxes` to return `displayMode`

**Files:**

- Modify: `worker/src/routers/admin-inboxes-router.ts`
- Test: `worker/src/__tests__/admin-inboxes-router.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `worker/src/__tests__/admin-inboxes-router.test.ts` inside the `describe("admin inboxes router", () => { … })` block, before the closing `});`:

```ts
it("GET returns displayMode (defaulting to 'thread' when no row)", async () => {
  const { apiKey } = await createTestUser({ role: "admin" });
  await createTestPerson();
  await createTestEmail({ recipient: "a@x.com" });
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: "b@x.com",
    displayName: "Bee",
    displayMode: "chat",
    createdAt: now,
    updatedAt: now,
  });
  const res = await authFetch("/api/admin/inboxes", { apiKey });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{
    email: string;
    displayName: string | null;
    displayMode: "thread" | "chat";
  }>;
  const byEmail = Object.fromEntries(body.map((b) => [b.email, b]));
  expect(byEmail["a@x.com"].displayMode).toBe("thread");
  expect(byEmail["b@x.com"].displayMode).toBe("chat");
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `yarn test --run worker/src/__tests__/admin-inboxes-router.test.ts`
Expected: the new test fails (no `displayMode` field in response). Other tests still pass.

- [ ] **Step 3: Update the route schema and SQL**

In `worker/src/routers/admin-inboxes-router.ts`, replace the `InboxRowSchema` definition (around line 14) with:

```ts
const InboxRowSchema = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  displayMode: z.enum(["thread", "chat"]),
  assignedUserIds: z.array(z.string()),
});
```

In the same file, update the SQL `SELECT` inside `adminInboxesRouter.openapi(listInboxesRoute, …)` to include `s.display_mode`. The full handler body becomes:

```ts
adminInboxesRouter.openapi(listInboxesRoute, async (c) => {
  const db = c.get("db");
  type Row = {
    email: string;
    displayName: string | null;
    displayMode: "thread" | "chat" | null;
    assignedUserIds: string | null;
  };
  const rows = await db.all<Row>(sql`
    WITH universe AS (
      SELECT DISTINCT recipient AS email FROM ${emails}
      UNION
      SELECT email FROM ${senderIdentities}
    )
    SELECT
      u.email AS email,
      s.display_name AS displayName,
      s.display_mode AS displayMode,
      (
        SELECT COALESCE(
          '[' || GROUP_CONCAT('"' || ip.user_id || '"') || ']',
          '[]'
        )
        FROM ${inboxPermissions} ip
        WHERE ip.email = u.email
      ) AS assignedUserIds
    FROM universe u
    LEFT JOIN ${senderIdentities} s ON s.email = u.email
    ORDER BY u.email
  `);

  return c.json(
    rows.map((r) => ({
      email: r.email,
      displayName: r.displayName,
      displayMode: r.displayMode ?? "thread",
      assignedUserIds: r.assignedUserIds ? JSON.parse(r.assignedUserIds) : [],
    })),
    200,
  );
});
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `yarn test --run worker/src/__tests__/admin-inboxes-router.test.ts`
Expected: all tests pass, including the new `displayMode` case.

- [ ] **Step 5: Commit**

```bash
git add worker/src/routers/admin-inboxes-router.ts worker/src/__tests__/admin-inboxes-router.test.ts
git commit -m "feat(admin-inboxes): return displayMode on list response"
```

---

### Task 3: Update `PATCH /admin/inboxes/{email}` to accept partial body with `displayMode`

**Files:**

- Modify: `worker/src/routers/admin-inboxes-router.ts`
- Test: `worker/src/__tests__/admin-inboxes-router.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `worker/src/__tests__/admin-inboxes-router.test.ts` inside the `describe` block:

```ts
it("PATCH persists displayMode independently of displayName", async () => {
  const { apiKey } = await createTestUser({ role: "admin" });
  await createTestPerson();
  await createTestEmail({ recipient: "a@x.com" });
  const res = await authFetch(
    `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
    {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ displayMode: "chat" }),
    },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    email: string;
    displayName: string | null;
    displayMode: "thread" | "chat";
  };
  expect(body.displayMode).toBe("chat");
  expect(body.displayName).toBeNull();
  const rows = await getDb()
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.email, "a@x.com"));
  expect(rows[0]?.displayMode).toBe("chat");
  expect(rows[0]?.displayName).toBeNull();
});

it("PATCH keeps the row when displayName=null but displayMode=chat", async () => {
  const { apiKey } = await createTestUser({ role: "admin" });
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: "a@x.com",
    displayName: "Alpha",
    displayMode: "chat",
    createdAt: now,
    updatedAt: now,
  });
  const res = await authFetch(
    `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
    {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ displayName: null }),
    },
  );
  expect(res.status).toBe(200);
  const rows = await getDb()
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.email, "a@x.com"));
  expect(rows).toHaveLength(1);
  expect(rows[0].displayName).toBeNull();
  expect(rows[0].displayMode).toBe("chat");
});

it("PATCH deletes the row when both fields are at defaults", async () => {
  const { apiKey } = await createTestUser({ role: "admin" });
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: "a@x.com",
    displayName: "Alpha",
    displayMode: "chat",
    createdAt: now,
    updatedAt: now,
  });
  const res = await authFetch(
    `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
    {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ displayName: null, displayMode: "thread" }),
    },
  );
  expect(res.status).toBe(200);
  const rows = await getDb()
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.email, "a@x.com"));
  expect(rows).toHaveLength(0);
});

it("PATCH returns 400 when neither field is provided", async () => {
  const { apiKey } = await createTestUser({ role: "admin" });
  const res = await authFetch(
    `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
    {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({}),
    },
  );
  expect(res.status).toBe(400);
});
```

You will also need to update the existing `PATCH clears display name when null is provided` test — it currently asserts that the row is _deleted_ when only `displayName: null` is sent. After this task, that assertion is only correct when `displayMode` is also at the default `'thread'`. Since the test seeds the row with the default mode (the existing insert doesn't set it, so it defaults to `'thread'` after migration), the assertion remains valid, but to be defensive add `displayMode: "thread"` to the seed insert and keep the assertion. Edit the existing test:

```ts
// inside `it("PATCH clears display name when null is provided", …)`
await getDb().insert(senderIdentities).values({
  email: "a@x.com",
  displayName: "Alpha",
  displayMode: "thread", // ← add this line so test intent is explicit
  createdAt: now,
  updatedAt: now,
});
```

- [ ] **Step 2: Run tests to confirm the new ones fail**

Run: `yarn test --run worker/src/__tests__/admin-inboxes-router.test.ts`
Expected: the four new tests fail (current PATCH ignores `displayMode` and the body validator rejects/ignores fields). Existing tests still pass.

- [ ] **Step 3: Update the PATCH route**

In `worker/src/routers/admin-inboxes-router.ts`, replace the existing `patchInboxRoute` definition and its handler with:

```ts
const PatchInboxBodySchema = z
  .object({
    displayName: z.string().nullable().optional(),
    displayMode: z.enum(["thread", "chat"]).optional(),
  })
  .refine(
    (b) => b.displayName !== undefined || b.displayMode !== undefined,
    "must update at least one field",
  );

const patchInboxRoute = createRoute({
  method: "patch",
  path: "/{email}",
  tags: ["Admin Inboxes"],
  description:
    "Update display name and/or display mode for an inbox. Row is deleted only when both fields are at defaults (null + 'thread').",
  request: {
    params: z.object({ email: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: PatchInboxBodySchema,
        },
      },
    },
  },
  responses: {
    ...json200Response(
      z.object({
        email: z.string(),
        displayName: z.string().nullable(),
        displayMode: z.enum(["thread", "chat"]),
      }),
      "Updated",
    ),
  },
});

adminInboxesRouter.openapi(patchInboxRoute, async (c) => {
  const db = c.get("db");
  const { email } = c.req.valid("param");
  const body = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  // Load current row (if any) so we can apply a partial update without losing
  // the field the caller didn't touch.
  const current = await db
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.email, email))
    .limit(1);
  const currentRow = current[0];

  const nextDisplayName =
    body.displayName !== undefined
      ? body.displayName === ""
        ? null
        : body.displayName
      : (currentRow?.displayName ?? null);
  const nextDisplayMode =
    body.displayMode !== undefined
      ? body.displayMode
      : (currentRow?.displayMode ?? "thread");

  // Both fields at defaults → delete the row to keep the table sparse.
  if (nextDisplayName === null && nextDisplayMode === "thread") {
    await db.delete(senderIdentities).where(eq(senderIdentities.email, email));
    return c.json({ email, displayName: null, displayMode: "thread" }, 200);
  }

  await db
    .insert(senderIdentities)
    .values({
      email,
      displayName: nextDisplayName,
      displayMode: nextDisplayMode,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: senderIdentities.email,
      set: {
        displayName: nextDisplayName,
        displayMode: nextDisplayMode,
        updatedAt: now,
      },
    });

  return c.json(
    { email, displayName: nextDisplayName, displayMode: nextDisplayMode },
    200,
  );
});
```

- [ ] **Step 4: Run tests to confirm everything passes**

Run: `yarn test --run worker/src/__tests__/admin-inboxes-router.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Type-check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add worker/src/routers/admin-inboxes-router.ts worker/src/__tests__/admin-inboxes-router.test.ts
git commit -m "feat(admin-inboxes): PATCH accepts partial body with displayMode"
```

---

## Phase 3 — Person emails endpoint shape change

### Task 4: Change `GET /api/emails/by-person/{personId}` to return `{ emails, inboxes }`

**Files:**

- Modify: `worker/src/routers/emails-router.ts`
- Modify: `worker/src/__tests__/emails-router.test.ts`

- [ ] **Step 1: Update the existing tests for the new shape**

Open `worker/src/__tests__/emails-router.test.ts`. In each of the four `it(…)` blocks under `describe("GET /api/emails/by-person/:personId", …)` (lines 29, 60, 96, 114), replace `const data = await res.json();` with:

```ts
const body = (await res.json()) as { emails: any[]; inboxes: any[] };
const data = body.emails;
```

Leave all `expect(data…)` assertions exactly as they are.

- [ ] **Step 2: Add a new test asserting the `inboxes` payload**

Append a new test inside the same `describe("GET /api/emails/by-person/:personId", …)` block:

```ts
it("returns inboxes[] with displayMode for each inbox referenced by emails", async () => {
  const db = getDb();
  await createTestPerson({ id: "s1", email: "a@test.com" });
  await createTestEmail({
    id: "e1",
    personId: "s1",
    recipient: "support@cmail.test",
  });

  const now = Math.floor(Date.now() / 1000);
  await db.insert(sentEmails).values({
    id: "se1",
    personId: "s1",
    fromAddress: "sales@cmail.test",
    toAddress: "a@test.com",
    subject: "Hi",
    bodyHtml: "<p>Hi</p>",
    bodyText: null,
    resendId: null,
    status: "sent",
    sentAt: now + 10,
    createdAt: now + 10,
  });

  // Set support@ to chat mode; sales@ has no row → defaults to thread.
  await db.insert(senderIdentities).values({
    email: "support@cmail.test",
    displayName: null,
    displayMode: "chat",
    createdAt: now,
    updatedAt: now,
  });

  const res = await authFetch("/api/emails/by-person/s1", { apiKey });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    emails: any[];
    inboxes: Array<{
      email: string;
      displayName: string | null;
      displayMode: "thread" | "chat";
    }>;
  };
  const byEmail = Object.fromEntries(body.inboxes.map((i) => [i.email, i]));
  expect(byEmail["support@cmail.test"]?.displayMode).toBe("chat");
  expect(byEmail["sales@cmail.test"]?.displayMode).toBe("thread");
});
```

- [ ] **Step 3: Run tests to confirm they fail**

Run: `yarn test --run worker/src/__tests__/emails-router.test.ts`
Expected: the four updated tests fail (response is still an array, not an object), and the new `inboxes[]` test fails.

- [ ] **Step 4: Update the route**

In `worker/src/routers/emails-router.ts`:

(a) Add import at the top alongside the other db imports:

```ts
import { senderIdentities } from "../db/sender-identities.schema";
```

Also add `inArray` to the existing `drizzle-orm` import line:

```ts
import { eq, desc, like, and, sql, inArray } from "drizzle-orm";
```

(b) Add a new schema near `EmailSchema` (around line 17):

```ts
const InboxMetaSchema = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  displayMode: z.enum(["thread", "chat"]),
});

const PersonEmailsResponseSchema = z.object({
  emails: z.array(EmailSchema),
  inboxes: z.array(InboxMetaSchema),
});
```

(c) Change the `responses` of `listPersonEmailsRoute` from:

```ts
responses: {
  ...json200Response(z.array(EmailSchema), "Emails for person"),
},
```

to:

```ts
responses: {
  ...json200Response(PersonEmailsResponseSchema, "Emails + per-inbox metadata for person"),
},
```

(d) At the very end of the `emailsRouter.openapi(listPersonEmailsRoute, …)` handler, replace the final `return c.json(result, 200);` with:

```ts
// Collect distinct inbox addresses referenced by the returned emails.
const inboxAddrs = new Set<string>();
for (const e of result) {
  if (e.type === "received" && e.recipient) inboxAddrs.add(e.recipient);
  if (e.type === "sent" && e.fromAddress) inboxAddrs.add(e.fromAddress);
}
const addrList = [...inboxAddrs];

const identities =
  addrList.length > 0
    ? await db
        .select({
          email: senderIdentities.email,
          displayName: senderIdentities.displayName,
          displayMode: senderIdentities.displayMode,
        })
        .from(senderIdentities)
        .where(inArray(senderIdentities.email, addrList))
    : [];
const identityMap = new Map(identities.map((r) => [r.email, r]));

const inboxesMeta = addrList.map((email) => {
  const id = identityMap.get(email);
  return {
    email,
    displayName: id?.displayName ?? null,
    displayMode: (id?.displayMode ?? "thread") as "thread" | "chat",
  };
});

return c.json({ emails: result, inboxes: inboxesMeta }, 200);
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `yarn test --run worker/src/__tests__/emails-router.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Run the full backend test suite to catch regressions**

Run: `yarn test`
Expected: all tests pass. If any other test file consumes `/api/emails/by-person/...` (search with `grep -r 'by-person' worker/src/__tests__`), update those too — but at the time of writing only `emails-router.test.ts` and `inbox-scoping.test.ts` reference it. Inspect `inbox-scoping.test.ts` for matching call sites; update them with the same `body.emails` unwrap pattern if they read the response.

- [ ] **Step 7: Type-check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 8: Commit**

```bash
git add worker/src/routers/emails-router.ts worker/src/__tests__/emails-router.test.ts worker/src/__tests__/inbox-scoping.test.ts
git commit -m "feat(emails): GET by-person returns { emails, inboxes } with per-inbox displayMode"
```

> If `inbox-scoping.test.ts` was unaffected, omit it from the `git add` line.

---

## Phase 4 — Frontend API layer

### Task 5: Update types and helpers in `src/lib/api.ts`

**Files:**

- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the `InboxMeta` type and the union for display mode**

In `src/lib/api.ts`, add after the `Email` interface (around line 36):

```ts
export type InboxDisplayMode = "thread" | "chat";

export interface InboxMeta {
  email: string;
  displayName: string | null;
  displayMode: InboxDisplayMode;
}

export interface PersonEmailsResponse {
  emails: Email[];
  inboxes: InboxMeta[];
}
```

- [ ] **Step 2: Update `fetchPersonEmails`**

Replace the existing `fetchPersonEmails` function (around line 112) with:

```ts
export async function fetchPersonEmails(
  personId: string,
  params?: { q?: string; recipient?: string; page?: number; limit?: number },
): Promise<PersonEmailsResponse> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.recipient) qs.set("recipient", params.recipient);
  if (params?.page) qs.set("page", params.page.toString());
  if (params?.limit) qs.set("limit", params.limit.toString());
  return apiFetch(`/api/emails/by-person/${personId}?${qs}`);
}
```

- [ ] **Step 3: Extend `AdminInbox` and add `updateInboxSettings`; replace `updateInboxDisplayName`**

Replace the `AdminInbox` interface (around line 475) with:

```ts
export interface AdminInbox {
  email: string;
  displayName: string | null;
  displayMode: InboxDisplayMode;
  assignedUserIds: string[];
}
```

Replace `updateInboxDisplayName` (around line 485) with:

```ts
export async function updateInboxSettings(
  email: string,
  patch: { displayName?: string | null; displayMode?: InboxDisplayMode },
): Promise<{
  email: string;
  displayName: string | null;
  displayMode: InboxDisplayMode;
}> {
  return apiFetch(`/api/admin/inboxes/${encodeURIComponent(email)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}
```

- [ ] **Step 4: Type-check (will reveal call-site failures)**

Run: `yarn tsc --noEmit`
Expected: errors at call sites of `fetchPersonEmails` (now returns an object) and `updateInboxDisplayName` (no longer exported). We fix those in the next tasks. Keep going — do not commit yet.

- [ ] **Step 5: Provisional fix — adapt `PersonDetail.tsx` minimally so the build is green**

In `src/pages/PersonDetail.tsx`, find both call sites of `fetchPersonEmails` (in `refetchEmails` and the initial-fetch `useEffect`). Update them to extract `.emails`:

```ts
function refetchEmails() {
  fetchPersonEmails(person.id).then((res) => setEmails(res.emails));
}

// inside the useEffect
fetchPersonEmails(person.id)
  .then((res) => setEmails(res.emails))
  .finally(() => setLoading(false));
```

This is intentionally minimal — Phase 8 will replace this with proper `inboxModeMap` plumbing. We just want a clean type-check now.

- [ ] **Step 6: Provisional fix — `AdminInboxTable.tsx`**

In `src/components/AdminInboxTable.tsx`, replace the import line for `updateInboxDisplayName` to import `updateInboxSettings` instead. Find:

```ts
import {
  fetchAdminInboxes,
  fetchAdminUsers,
  updateInboxAssignments,
  updateInboxDisplayName,
  type AdminInbox,
  type AdminUser,
} from "@/lib/api";
```

Change `updateInboxDisplayName` to `updateInboxSettings`. Then update the `handleNameBlur` function to call the new helper:

```ts
async function handleNameBlur(inbox: AdminInbox, value: string) {
  const next = value.trim() === "" ? null : value.trim();
  if (next === inbox.displayName) return;
  const res = await updateInboxSettings(inbox.email, { displayName: next });
  setInboxes((prev) =>
    prev.map((r) =>
      r.email === inbox.email
        ? { ...r, displayName: res.displayName, displayMode: res.displayMode }
        : r,
    ),
  );
}
```

- [ ] **Step 7: Type-check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api.ts src/pages/PersonDetail.tsx src/components/AdminInboxTable.tsx
git commit -m "feat(api-client): add InboxDisplayMode types, updateInboxSettings, PersonEmailsResponse"
```

---

## Phase 5 — Admin UI: Mode segmented control

### Task 6: Add a Mode segmented control to `AdminInboxTable`

**Files:**

- Modify: `src/components/AdminInboxTable.tsx`

- [ ] **Step 1: Add a handler for changing mode**

In `src/components/AdminInboxTable.tsx`, add this handler below `handleToggleAssignment`:

```ts
async function handleSetMode(inbox: AdminInbox, next: "thread" | "chat") {
  if (inbox.displayMode === next) return;
  // Optimistic update with rollback on error.
  const prev = inbox.displayMode;
  setInboxes((all) =>
    all.map((r) => (r.email === inbox.email ? { ...r, displayMode: next } : r)),
  );
  try {
    const res = await updateInboxSettings(inbox.email, { displayMode: next });
    setInboxes((all) =>
      all.map((r) =>
        r.email === inbox.email ? { ...r, displayMode: res.displayMode } : r,
      ),
    );
  } catch (err) {
    setInboxes((all) =>
      all.map((r) =>
        r.email === inbox.email ? { ...r, displayMode: prev } : r,
      ),
    );
    console.error("Failed to update inbox mode", err);
  }
}
```

- [ ] **Step 2: Render the segmented control**

Inside the `inboxes.map((inbox) => …)` JSX, place this block immediately _after_ the `<input>` for display name (after the closing `</div>` that wraps `flex-1`, but before the `Members` block). Find the `<div className="mt-4">` that begins the Members section and insert this just above it:

```tsx
<div className="mt-3">
  <div className="mb-1 text-xs uppercase tracking-wide text-text-tertiary">
    Mode
  </div>
  <div className="inline-flex rounded-md border border-border overflow-hidden">
    {(["thread", "chat"] as const).map((m) => {
      const active = inbox.displayMode === m;
      return (
        <button
          key={m}
          type="button"
          onClick={() => handleSetMode(inbox, m)}
          className={`px-3 py-1 text-xs font-medium ${
            active
              ? "bg-accent text-white"
              : "bg-white text-text-secondary hover:bg-bg-muted"
          }`}
          aria-pressed={active}
        >
          {m === "thread" ? "Thread" : "Chat"}
        </button>
      );
    })}
  </div>
  <div className="mt-1 text-xs text-text-tertiary">
    Chat mode shows the last 5 messages as bubbles with an inline reply.
  </div>
</div>
```

- [ ] **Step 3: Type-check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `yarn dev` then visit `/inboxes` (admin only). Confirm each inbox card shows the Mode control, clicking flips state, and refresh persists the choice.

- [ ] **Step 5: Commit**

```bash
git add src/components/AdminInboxTable.tsx
git commit -m "feat(admin-inboxes): add Thread/Chat display mode control"
```

---

## Phase 6 — Extract `ThreadInboxSection`

### Task 7: Extract the existing per-inbox section JSX into a reusable component

**Files:**

- Create: `src/components/ThreadInboxSection.tsx`
- Modify: `src/pages/PersonDetail.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/ThreadInboxSection.tsx` with:

```tsx
import { MessageSquare, Inbox } from "lucide-react";
import MessageBubble from "@/components/MessageBubble";
import type { Email } from "@/lib/api";

export interface ThreadInboxGroup {
  inbox: string;
  emails: Email[]; // newest first
  latestTimestamp: number;
}

interface ThreadInboxSectionProps {
  group: ThreadInboxGroup;
  personEmail: string;
  isOlderExpanded: boolean;
  onToggleOlder: () => void;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
  onDelete: (emailId: string) => void;
}

export default function ThreadInboxSection({
  group,
  personEmail,
  isOlderExpanded,
  onToggleOlder,
  onOpenHtml,
  onMarkRead,
  onReply,
  onDelete,
}: ThreadInboxSectionProps) {
  // Within a group, emails arrive newest-first. Show the latest expanded (HTML)
  // and collapse older messages behind a toggle.
  const latest = group.emails[0];
  const olderChronological = group.emails.slice(1).reverse();

  return (
    <section className="border-b-4 border-border-subtle">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg-subtle px-4 sm:px-6 py-2">
        <Inbox size={12} className="text-text-tertiary" />
        <span className="text-[11px] font-medium text-text-secondary">
          {group.inbox}
        </span>
        <span className="text-[11px] text-text-tertiary">
          · {group.emails.length} email{group.emails.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="divide-y divide-border-subtle">
        {olderChronological.length > 0 && (
          <div className="px-4 sm:px-6 py-2">
            <button
              onClick={onToggleOlder}
              className="flex items-center gap-1.5 text-xs text-accent hover:underline"
            >
              <MessageSquare size={12} />
              {isOlderExpanded ? "Hide" : "Show"} {olderChronological.length}{" "}
              previous message{olderChronological.length !== 1 ? "s" : ""}
            </button>
          </div>
        )}
        {isOlderExpanded &&
          olderChronological.map((email) => (
            <MessageBubble
              key={email.id}
              email={email}
              personEmail={personEmail}
              onOpenHtml={onOpenHtml}
              onMarkRead={onMarkRead}
              onReply={onReply}
              onDelete={onDelete}
            />
          ))}
        {latest && (
          <MessageBubble
            key={latest.id}
            email={latest}
            personEmail={personEmail}
            onOpenHtml={onOpenHtml}
            onMarkRead={onMarkRead}
            onReply={onReply}
            onDelete={onDelete}
            renderHtml
          />
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Use it from `PersonDetail.tsx`**

In `src/pages/PersonDetail.tsx`:

(a) Add the import near the other component imports:

```ts
import ThreadInboxSection from "@/components/ThreadInboxSection";
```

(b) Remove the now-unused imports `MessageSquare` and `Inbox` from `lucide-react`, and remove the `MessageBubble` import (it's now only used by `ThreadInboxSection`). The line currently looks like:

```ts
import { MessageSquare, Inbox } from "lucide-react";
```

Delete it. Also remove:

```ts
import MessageBubble from "@/components/MessageBubble";
```

(c) Inside the `inboxGroups.map((group) => …)` block in the JSX, replace the entire returned `<section …>…</section>` block with:

```tsx
<ThreadInboxSection
  key={group.inbox}
  group={group}
  personEmail={person.email}
  isOlderExpanded={!!expandedOlder[group.inbox]}
  onToggleOlder={() =>
    setExpandedOlder((prev) => ({
      ...prev,
      [group.inbox]: !prev[group.inbox],
    }))
  }
  onOpenHtml={setHtmlPreviewEmail}
  onMarkRead={handleMarkRead}
  onReply={setReplyToEmailId}
  onDelete={handleDelete}
/>
```

(d) The local `interface InboxGroup` in `PersonDetail.tsx` is now redundant with `ThreadInboxGroup`. Replace its usage by importing the type:

```ts
import ThreadInboxSection, {
  type ThreadInboxGroup,
} from "@/components/ThreadInboxSection";
```

Then delete the local `InboxGroup` interface. Update `groupEmailsByInbox` return type to `ThreadInboxGroup[]` and the `InboxGroup` references inside that function to `ThreadInboxGroup`.

- [ ] **Step 3: Type-check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Manual smoke**

Run: `yarn dev` and verify the existing person-detail view still looks identical (all groups still render in thread mode because no inbox has been set to chat yet).

- [ ] **Step 5: Commit**

```bash
git add src/components/ThreadInboxSection.tsx src/pages/PersonDetail.tsx
git commit -m "refactor(person-detail): extract ThreadInboxSection (no behavior change)"
```

---

## Phase 7 — `ChatQuickReply` component

### Task 8: Build the always-visible plain-text quick reply

**Files:**

- Create: `src/components/ChatQuickReply.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/ChatQuickReply.tsx` with:

```tsx
import { useState, useRef, useEffect } from "react";
import { replyToEmail } from "@/lib/api";

interface ChatQuickReplyProps {
  inboxAddress: string; // From address, fixed to this section's inbox
  latestReceivedEmailId: string | null; // What we reply to
  onSent: () => void; // Refetch + scroll
}

// Wrap user-entered plain text into the minimal HTML the existing reply route
// requires (it 400s without bodyHtml or templateSlug).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainTextToHtml(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line) =>
      line.length === 0 ? "<p>&nbsp;</p>" : `<p>${escapeHtml(line)}</p>`,
    )
    .join("");
}

export default function ChatQuickReply({
  inboxAddress,
  latestReceivedEmailId,
  onSent,
}: ChatQuickReplyProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow: set height to scrollHeight, clamped to ~6 lines (~ 132px).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const max = 132;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  const canSend = text.trim().length > 0 && !sending && !!latestReceivedEmailId;

  async function handleSend() {
    if (!canSend || !latestReceivedEmailId) return;
    setSending(true);
    setError(null);
    try {
      await replyToEmail(latestReceivedEmailId, {
        bodyHtml: plainTextToHtml(text),
        bodyText: text,
        fromAddress: inboxAddress,
      });
      setText("");
      onSent();
    } catch (e) {
      setError("Failed to send reply");
      console.error(e);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter inserts a newline (default). Cmd/Ctrl+Enter sends.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="border-t border-border bg-white px-4 py-2">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={
            latestReceivedEmailId
              ? "Type a reply…"
              : "Waiting for a message to reply to."
          }
          disabled={!latestReceivedEmailId}
          className="flex-1 resize-none rounded-md border border-border bg-white px-2 py-1.5 text-xs text-text-primary outline-none focus:ring-1 focus:ring-accent disabled:bg-bg-muted disabled:text-text-tertiary"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between">
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : (
          <span className="text-[11px] text-text-tertiary">
            Plain text · sent from {inboxAddress} · ⌘/Ctrl+Enter to send
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatQuickReply.tsx
git commit -m "feat(person-detail): add ChatQuickReply plain-text composer"
```

---

## Phase 8 — `ChatInboxSection` component

### Task 9: Build the iMessage-style bubble layout

**Files:**

- Create: `src/components/ChatInboxSection.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/ChatInboxSection.tsx` with:

```tsx
import { useState, useMemo } from "react";
import { Inbox, Maximize2, Paperclip, Trash2 } from "lucide-react";
import type { Email } from "@/lib/api";
import type { ThreadInboxGroup } from "@/components/ThreadInboxSection";
import ChatQuickReply from "@/components/ChatQuickReply";

interface ChatInboxSectionProps {
  group: ThreadInboxGroup;
  personEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onDelete: (emailId: string) => void;
  onSent: () => void;
}

const INITIAL_VISIBLE = 5;
const PAGE_SIZE = 20;
const BUBBLE_TRUNCATE_CHARS = 480; // ~6 lines

function emailToText(email: Email): string {
  if (email.bodyText) return email.bodyText;
  if (email.bodyHtml) {
    return (
      new DOMParser().parseFromString(email.bodyHtml, "text/html").body
        .textContent ?? ""
    );
  }
  return "";
}

interface BubbleProps {
  email: Email;
  personEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onDelete: (emailId: string) => void;
}

function Bubble({
  email,
  personEmail,
  onOpenHtml,
  onMarkRead,
  onDelete,
}: BubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const isSent = email.type === "sent";
  const isUnread = email.type === "received" && email.isRead === 0;

  const text = useMemo(() => emailToText(email), [email]);
  const truncated = text.length > BUBBLE_TRUNCATE_CHARS && !expanded;
  const displayText = truncated
    ? text.slice(0, BUBBLE_TRUNCATE_CHARS).trimEnd() + "…"
    : text;

  const ts = new Date(email.timestamp * 1000);
  const stamp =
    ts.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const downloadable = (email.attachments ?? []).filter((a) => !a.contentId);

  function handleClick() {
    if (isUnread) onMarkRead(email);
  }

  return (
    <div
      className={`group flex flex-col px-4 sm:px-6 py-1 ${
        isSent ? "items-end" : "items-start"
      }`}
      onClick={handleClick}
      title={email.subject ?? undefined}
    >
      <div
        className={`max-w-[78%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
          isSent ? "bg-accent text-white" : "bg-bg-muted text-text-primary"
        } ${isUnread ? "ring-1 ring-accent" : ""}`}
      >
        {displayText ? (
          <p className="whitespace-pre-wrap">{displayText}</p>
        ) : (
          <p className="italic opacity-70">(no text content)</p>
        )}
        {text.length > BUBBLE_TRUNCATE_CHARS && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className={`mt-1 text-[11px] underline ${
              isSent ? "text-white/80" : "text-accent"
            }`}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>

      {downloadable.length > 0 && (
        <div
          className={`mt-1 flex flex-wrap gap-1.5 max-w-[78%] ${
            isSent ? "justify-end" : "justify-start"
          }`}
        >
          {downloadable.map((att) => (
            <a
              key={att.id}
              href={`/api/attachments/${att.id}`}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 rounded border border-border bg-white px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-muted"
            >
              <Paperclip size={10} />
              {att.filename}
            </a>
          ))}
        </div>
      )}

      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-tertiary">
        <span>{stamp}</span>
        {email.bodyHtml && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenHtml(email);
            }}
            className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity hover:text-text-secondary"
            title="View original"
          >
            <Maximize2 size={10} />
            View original
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(email.id);
          }}
          className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400"
          title="Delete email"
        >
          <Trash2 size={10} />
        </button>
        {isUnread && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </div>
    </div>
  );
}

export default function ChatInboxSection({
  group,
  personEmail,
  onOpenHtml,
  onMarkRead,
  onDelete,
  onSent,
}: ChatInboxSectionProps) {
  // group.emails is newest-first. Chat displays chronological (oldest → newest)
  // with the most recent at the bottom.
  const chronological = useMemo(
    () => [...group.emails].reverse(),
    [group.emails],
  );
  const total = chronological.length;
  const [visible, setVisible] = useState(Math.min(INITIAL_VISIBLE, total));
  const start = Math.max(0, total - visible);
  const visibleEmails = chronological.slice(start);
  const hiddenCount = start;

  // Latest received email — the target of the quick reply.
  // group.emails is newest-first, so .find returns the most recent received.
  const replyTarget = useMemo(
    () => group.emails.find((e) => e.type === "received") ?? null,
    [group.emails],
  );

  return (
    <section className="border-b-4 border-border-subtle flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg-subtle px-4 sm:px-6 py-2">
        <Inbox size={12} className="text-text-tertiary" />
        <span className="text-[11px] font-medium text-text-secondary">
          {group.inbox}
        </span>
        <span className="text-[11px] text-text-tertiary">
          · {total} email{total !== 1 ? "s" : ""} · chat mode
        </span>
      </div>

      <div className="flex flex-col py-2 gap-1">
        {hiddenCount > 0 && (
          <div className="px-4 sm:px-6 py-1">
            <button
              type="button"
              onClick={() => setVisible((v) => Math.min(total, v + PAGE_SIZE))}
              className="text-xs text-accent hover:underline"
            >
              Show {Math.min(PAGE_SIZE, hiddenCount)} earlier message
              {Math.min(PAGE_SIZE, hiddenCount) !== 1 ? "s" : ""}
            </button>
          </div>
        )}

        {visibleEmails.map((email) => (
          <Bubble
            key={email.id}
            email={email}
            personEmail={personEmail}
            onOpenHtml={onOpenHtml}
            onMarkRead={onMarkRead}
            onDelete={onDelete}
          />
        ))}
      </div>

      <ChatQuickReply
        inboxAddress={group.inbox}
        latestReceivedEmailId={replyTarget?.id ?? null}
        onSent={onSent}
      />
    </section>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatInboxSection.tsx
git commit -m "feat(person-detail): add ChatInboxSection with bubble layout and pagination"
```

---

## Phase 9 — Wire mode-based rendering in `PersonDetail`

### Task 10: Route each section to Thread or Chat renderer

**Files:**

- Modify: `src/pages/PersonDetail.tsx`

- [ ] **Step 1: Add state for `inboxModeMap`**

In `src/pages/PersonDetail.tsx`, near the other `useState` declarations, add:

```ts
import type { InboxDisplayMode, InboxMeta } from "@/lib/api";
// …
const [inboxModeMap, setInboxModeMap] = useState<Map<string, InboxDisplayMode>>(
  new Map(),
);
```

- [ ] **Step 2: Populate it from the fetch response**

Replace the two existing `fetchPersonEmails` call sites (in `refetchEmails` and the initial-fetch `useEffect`) with the full version that also captures inboxes:

```ts
function refetchEmails() {
  fetchPersonEmails(person.id).then((res) => {
    setEmails(res.emails);
    setInboxModeMap(new Map(res.inboxes.map((i) => [i.email, i.displayMode])));
  });
}

// inside the useEffect
fetchPersonEmails(person.id)
  .then((res) => {
    setEmails(res.emails);
    setInboxModeMap(new Map(res.inboxes.map((i) => [i.email, i.displayMode])));
  })
  .finally(() => setLoading(false));
```

- [ ] **Step 3: Import `ChatInboxSection`**

Add near the other imports:

```ts
import ChatInboxSection from "@/components/ChatInboxSection";
```

- [ ] **Step 4: Switch on mode inside the per-group render**

Find the `inboxGroups.map((group) => …)` block. Replace its body (currently returning a `<ThreadInboxSection …/>`) with:

```tsx
{
  inboxGroups.map((group) => {
    const mode = inboxModeMap.get(group.inbox) ?? "thread";
    if (mode === "chat") {
      return (
        <ChatInboxSection
          key={group.inbox}
          group={group}
          personEmail={person.email}
          onOpenHtml={setHtmlPreviewEmail}
          onMarkRead={handleMarkRead}
          onDelete={handleDelete}
          onSent={refetchEmails}
        />
      );
    }
    return (
      <ThreadInboxSection
        key={group.inbox}
        group={group}
        personEmail={person.email}
        isOlderExpanded={!!expandedOlder[group.inbox]}
        onToggleOlder={() =>
          setExpandedOlder((prev) => ({
            ...prev,
            [group.inbox]: !prev[group.inbox],
          }))
        }
        onOpenHtml={setHtmlPreviewEmail}
        onMarkRead={handleMarkRead}
        onReply={setReplyToEmailId}
        onDelete={handleDelete}
      />
    );
  });
}
```

- [ ] **Step 5: Make the page-level `ReplyComposer` only show for Thread sections**

The `replyToEmailId` state is set only by `ThreadInboxSection` (Chat sections do not call `onReply`), so the existing conditional `{replyToEmailId && <ReplyComposer …/>}` already self-gates. No further change needed — verify by reading the JSX.

- [ ] **Step 6: Type-check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 7: Manual QA via dev seed**

Run:

```bash
yarn db:seed:dev
yarn dev
```

Then:

1. Sign in as admin, go to **Inboxes**, set one inbox (e.g., `support@…`) to **Chat** and leave another in **Thread**.
2. Open a person who has email at both inboxes. The `support@` section renders as bubbles; the other still renders as thread.
3. Type into the chat quick reply, hit Send. The textarea clears, the new sent bubble appears at the bottom after refetch.
4. Click "View original" on a bubble that came from HTML email → `EmailHtmlModal` opens with full HTML.
5. Inbox with > 5 messages → "Show N earlier messages" reveals more in batches of 20.
6. Flip the inbox back to **Thread** in admin → reload the person → original layout returns.

- [ ] **Step 8: Run the full test suite**

Run: `yarn test`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/pages/PersonDetail.tsx
git commit -m "feat(person-detail): render Chat or Thread per inbox displayMode"
```

---

## Phase 10 — Final verification

### Task 11: Whole-tree typecheck and test pass

- [ ] **Step 1: Type-check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 2: Tests**

Run: `yarn test`
Expected: all pass.

- [ ] **Step 3: Lint formatting check**

Run: `git status`
Expected: clean working tree (lint-staged ran on each commit; no lingering reformatted files).

- [ ] **Step 4: Walk the manual QA checklist from the spec**

Open `docs/superpowers/specs/2026-04-17-inbox-display-mode-chat-vs-thread-design.md`, scroll to the "Manual QA checklist" section, and tick each item against the running `yarn dev` instance. If any step fails, file it as a follow-up bug; don't paper over it.

- [ ] **Step 5: Mark plan complete**

No commit needed — the plan file lives in `docs/` and is not modified by execution.

---

## Self-Review Notes (author's checklist)

- **Spec coverage.** Each section of the spec has a phase: Data Model → Phase 1; API → Phases 2 & 3; Admin UI → Phase 5; Detail rendering → Phases 6, 8, 9; Quick reply → Phase 7; Edge cases drop out of the rendering logic (mode default, mixed-mode, "View original", auto-scroll); Testing → tests in Phases 2 & 3 plus the manual QA in Phase 9 and 10.
- **No placeholders.** Every step contains the actual code or command to run.
- **Type consistency.** `InboxDisplayMode`, `InboxMeta`, `PersonEmailsResponse`, `ThreadInboxGroup`, and `updateInboxSettings` are defined once and reused with the same names everywhere they appear.
- **HTML wrapping.** Phase 7's `plainTextToHtml` is the agreed mitigation for the reply route's `bodyHtml` requirement (verified at `worker/src/routers/send-router.ts:218`).
