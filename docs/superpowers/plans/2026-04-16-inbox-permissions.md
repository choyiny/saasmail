# Inbox Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admins to grant non-admin members access to specific inboxes (email addresses). Members can fully read, send, and manage sequences/templates only for their assigned inboxes. Admins retain unrestricted access.

**Architecture:** Add an `inbox_permissions(user_id, email)` table plus a per-request middleware that resolves `{ isAdmin } | { isAdmin: false, inboxes: string[] }` onto the Hono context. All content routers (stats, emails, people, send, sequences, templates) apply a shared `inboxFilter` for reads and `assertInboxAllowed` for writes. Add nullable `email_templates.from_address` so templates can be inbox-scoped. Delete `/api/sender-identities`; new admin surface `/api/admin/inboxes` handles both display-name and member-assignment management. Rename `/settings` page to `/inboxes`.

**Tech Stack:** Hono + Zod OpenAPI, Drizzle ORM on Cloudflare D1, React + Tailwind, Vitest with miniflare.

**Spec:** `docs/superpowers/specs/2026-04-16-inbox-permissions-design.md`

---

## File Structure

**New files:**

- `worker/src/db/inbox-permissions.schema.ts`
- `worker/src/lib/inbox-permissions.ts` (resolveAllowedInboxes, inboxFilter, assertInboxAllowed, AllowedInboxes type)
- `worker/src/middleware/inject-allowed-inboxes.ts`
- `worker/src/routers/admin-inboxes-router.ts`
- `worker/src/__tests__/inbox-permissions.test.ts` (unit tests for helpers)
- `worker/src/__tests__/admin-inboxes-router.test.ts` (admin surface)
- `worker/src/__tests__/inbox-scoping.test.ts` (end-to-end scoping across routers)
- `src/pages/InboxesPage.tsx`
- `src/components/AdminInboxTable.tsx`
- `migrations/<next>_inbox_permissions.sql` (generated)
- `migrations/<next+1>_email_templates_from_address.sql` (generated)

**Modified files:**

- `worker/src/db/schema.ts` — register new schema in barrel
- `worker/src/db/email-templates.schema.ts` — add nullable `from_address` column
- `worker/src/variables.ts` — add `allowedInboxes` to Variables
- `worker/src/index.ts` — register middleware; remove sender-identities router; mount admin inboxes router
- `worker/src/routers/stats-router.ts`
- `worker/src/routers/emails-router.ts`
- `worker/src/routers/people-router.ts`
- `worker/src/routers/send-router.ts`
- `worker/src/routers/sequences-router.ts`
- `worker/src/routers/email-templates-router.ts`
- `worker/src/__tests__/helpers.ts` — add migration SQL for new table/column; add `createTestInboxPermission` helper; extend `cleanDb`
- `src/App.tsx` — route `/inboxes`; redirect `/settings` → `/inboxes`; import `InboxesPage`
- `src/components/Sidebar.tsx` — rename label to "Inboxes", path `/inboxes`, make `adminOnly: true`
- `src/lib/api.ts` — remove sender-identity helpers; add admin-inbox helpers

**Deleted files:**

- `worker/src/routers/sender-identities-router.ts`
- `src/pages/SettingsPage.tsx`
- `src/components/SenderIdentitiesSettings.tsx`

---

### Task 1: Add `inbox_permissions` schema

**Files:**

- Create: `worker/src/db/inbox-permissions.schema.ts`
- Modify: `worker/src/db/schema.ts`

- [ ] **Step 1: Create the schema file**

```typescript
// worker/src/db/inbox-permissions.schema.ts
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

export const inboxPermissions = sqliteTable(
  "inbox_permissions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.email] }),
    index("inbox_permissions_email_idx").on(table.email),
  ],
);
```

- [ ] **Step 2: Register in the barrel export**

Open `worker/src/db/schema.ts`. Add import and entry:

```typescript
import { inboxPermissions } from "./inbox-permissions.schema";

export const schema = {
  ...authSchema,
  invitations,
  people,
  emails,
  sentEmails,
  attachments,
  emailTemplates,
  apiKeys,
  sequences,
  sequenceEnrollments,
  sequenceEmails,
  senderIdentities,
  inboxPermissions,
} as const;
```

- [ ] **Step 3: Generate the migration**

Run: `yarn drizzle-kit generate`

Expected: a new SQL migration file appears under `migrations/` creating `inbox_permissions` with the composite PK and index.

- [ ] **Step 4: Verify migration SQL**

Read the new migration file. It should contain SQL equivalent to:

```sql
CREATE TABLE `inbox_permissions` (
  `user_id` text NOT NULL,
  `email` text NOT NULL,
  `created_at` integer NOT NULL,
  `created_by` text,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
  PRIMARY KEY(`user_id`, `email`)
);
CREATE INDEX `inbox_permissions_email_idx` ON `inbox_permissions` (`email`);
```

- [ ] **Step 5: Update test helpers with the new DDL**

Open `worker/src/__tests__/helpers.ts`. Add this statement to the `statements` array (after the `sender_identities` entry):

```typescript
`CREATE TABLE IF NOT EXISTS inbox_permissions (user_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT, PRIMARY KEY(user_id, email), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL)`,
`CREATE INDEX IF NOT EXISTS inbox_permissions_email_idx ON inbox_permissions(email)`,
```

Add `DELETE FROM inbox_permissions;` to the `cleanDb` SQL block (place before `DELETE FROM users`).

- [ ] **Step 6: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/db/inbox-permissions.schema.ts worker/src/db/schema.ts migrations/ worker/src/__tests__/helpers.ts
git commit -m "feat: add inbox_permissions schema and migration"
```

---

### Task 2: Add `from_address` column to `email_templates`

**Files:**

- Modify: `worker/src/db/email-templates.schema.ts`
- Modify: `worker/src/__tests__/helpers.ts`

- [ ] **Step 1: Add the nullable column to the schema**

Replace the contents of `worker/src/db/email-templates.schema.ts`:

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const emailTemplates = sqliteTable("email_templates", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  bodyHtml: text("body_html").notNull(),
  fromAddress: text("from_address"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `yarn drizzle-kit generate`

Expected: new SQL file with `ALTER TABLE email_templates ADD COLUMN from_address text;`.

- [ ] **Step 3: Update test helpers DDL**

In `worker/src/__tests__/helpers.ts`, update the `email_templates` DDL to include the column:

Replace:

```typescript
`CREATE TABLE IF NOT EXISTS email_templates (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
```

With:

```typescript
`CREATE TABLE IF NOT EXISTS email_templates (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT NOT NULL, from_address TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
```

- [ ] **Step 4: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add worker/src/db/email-templates.schema.ts migrations/ worker/src/__tests__/helpers.ts
git commit -m "feat: add nullable from_address to email_templates"
```

---

### Task 3: Build permission resolution library (with tests)

**Files:**

- Create: `worker/src/lib/inbox-permissions.ts`
- Create: `worker/src/__tests__/inbox-permissions.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `worker/src/__tests__/inbox-permissions.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { users } from "../db/auth.schema";
import { emails } from "../db/emails.schema";
import {
  resolveAllowedInboxes,
  inboxFilter,
  assertInboxAllowed,
} from "../lib/inbox-permissions";

async function insertUser(id: string, role: string) {
  const now = Date.now();
  await getDb()
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@test.local`,
      emailVerified: false,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      role,
    });
}

async function insertPermission(userId: string, email: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
}

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("resolveAllowedInboxes", () => {
  it("returns isAdmin: true for admin users", async () => {
    await insertUser("u-admin", "admin");
    const db = getDb();
    const adminUser = (
      await db.select().from(users).where(eq(users.id, "u-admin")).limit(1)
    )[0];
    const result = await resolveAllowedInboxes(db, adminUser);
    expect(result).toEqual({ isAdmin: true });
  });

  it("returns member inboxes when assigned", async () => {
    await insertUser("u-mem", "member");
    await insertPermission("u-mem", "a@x.com");
    await insertPermission("u-mem", "b@x.com");
    const db = getDb();
    const memberUser = (
      await db.select().from(users).where(eq(users.id, "u-mem")).limit(1)
    )[0];
    const result = await resolveAllowedInboxes(db, memberUser);
    expect(result.isAdmin).toBe(false);
    if (!result.isAdmin) {
      expect(result.inboxes.sort()).toEqual(["a@x.com", "b@x.com"]);
    }
  });

  it("returns empty inbox list for member with no assignments", async () => {
    await insertUser("u-empty", "member");
    const db = getDb();
    const u = (
      await db.select().from(users).where(eq(users.id, "u-empty")).limit(1)
    )[0];
    const result = await resolveAllowedInboxes(db, u);
    expect(result).toEqual({ isAdmin: false, inboxes: [] });
  });
});

describe("inboxFilter", () => {
  it("returns undefined for admin", () => {
    expect(inboxFilter({ isAdmin: true }, emails.recipient)).toBeUndefined();
  });

  it("returns an inArray condition for member with inboxes", () => {
    const cond = inboxFilter(
      { isAdmin: false, inboxes: ["a@x.com"] },
      emails.recipient,
    );
    expect(cond).toBeDefined();
  });

  it("matches-nothing condition for member with no inboxes", async () => {
    // End-to-end check: when used in a WHERE, no rows should be returned.
    await insertUser("u-none", "member");
    const db = getDb();
    // Insert a row in emails so there is something to filter.
    const now = Math.floor(Date.now() / 1000);
    await db.run(sql`
      INSERT INTO emails (id, person_id, recipient, received_at, created_at, is_read)
      VALUES ('e1', 'p1', 'a@x.com', ${now}, ${now}, 0)
    `);
    const cond = inboxFilter({ isAdmin: false, inboxes: [] }, emails.recipient);
    const rows = await db.select().from(emails).where(cond!);
    expect(rows).toHaveLength(0);
  });
});

describe("assertInboxAllowed", () => {
  it("does not throw for admin regardless of address", () => {
    expect(() =>
      assertInboxAllowed({ isAdmin: true }, "anything@x.com"),
    ).not.toThrow();
  });

  it("does not throw when member has the inbox", () => {
    expect(() =>
      assertInboxAllowed({ isAdmin: false, inboxes: ["a@x.com"] }, "a@x.com"),
    ).not.toThrow();
  });

  it("throws 403 when member lacks the inbox", () => {
    expect(() =>
      assertInboxAllowed({ isAdmin: false, inboxes: ["a@x.com"] }, "b@x.com"),
    ).toThrowError(/Inbox not allowed/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test worker/src/__tests__/inbox-permissions.test.ts`
Expected: all tests fail with "Cannot find module '../lib/inbox-permissions'" or equivalent.

- [ ] **Step 3: Implement the library**

Create `worker/src/lib/inbox-permissions.ts`:

```typescript
import { eq, inArray, sql, SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AnyColumn } from "drizzle-orm";
import { inboxPermissions } from "../db/inbox-permissions.schema";

export type AllowedInboxes =
  | { isAdmin: true }
  | { isAdmin: false; inboxes: string[] };

export async function resolveAllowedInboxes(
  db: DrizzleD1Database<any>,
  user: { id: string; role: string | null },
): Promise<AllowedInboxes> {
  if (user.role === "admin") {
    return { isAdmin: true };
  }
  const rows = await db
    .select({ email: inboxPermissions.email })
    .from(inboxPermissions)
    .where(eq(inboxPermissions.userId, user.id));
  return { isAdmin: false, inboxes: rows.map((r) => r.email) };
}

/**
 * Returns a Drizzle SQL condition that restricts `column` to allowed inboxes.
 * - Admin → `undefined` (no filter; caller composes freely).
 * - Member with ≥1 inbox → `inArray(column, inboxes)`.
 * - Member with 0 inboxes → `sql\`0\`` (matches nothing).
 */
export function inboxFilter(
  allowed: AllowedInboxes,
  column: AnyColumn,
): SQL | undefined {
  if (allowed.isAdmin) return undefined;
  if (allowed.inboxes.length === 0) return sql`0`;
  return inArray(column, allowed.inboxes);
}

export function assertInboxAllowed(
  allowed: AllowedInboxes,
  email: string,
): void {
  if (allowed.isAdmin) return;
  if (!allowed.inboxes.includes(email)) {
    throw new HTTPException(403, { message: "Inbox not allowed" });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test worker/src/__tests__/inbox-permissions.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/inbox-permissions.ts worker/src/__tests__/inbox-permissions.test.ts
git commit -m "feat: add inbox permission resolution helpers"
```

---

### Task 4: Add middleware + variable type

**Files:**

- Modify: `worker/src/variables.ts`
- Create: `worker/src/middleware/inject-allowed-inboxes.ts`
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Extend Variables**

Replace contents of `worker/src/variables.ts`:

```typescript
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "./lib/inbox-permissions";

export type Variables = {
  user?: any;
  db: DrizzleD1Database<any>;
  allowedInboxes?: AllowedInboxes;
};
```

- [ ] **Step 2: Create the middleware**

Create `worker/src/middleware/inject-allowed-inboxes.ts`:

```typescript
import type { MiddlewareHandler } from "hono";
import type { Variables } from "../variables";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";

export const injectAllowedInboxes: MiddlewareHandler<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}> = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    // Should not happen — session middleware runs first — but guard anyway.
    return c.json({ error: "Unauthorized" }, 401);
  }
  const db = c.get("db");
  const allowed = await resolveAllowedInboxes(db, user);
  c.set("allowedInboxes", allowed);
  return next();
};
```

- [ ] **Step 3: Register middleware in index.ts**

Open `worker/src/index.ts`. Import the middleware:

```typescript
import { injectAllowedInboxes } from "./middleware/inject-allowed-inboxes";
```

After the session middleware block (the `app.use("/api/*", async (c, next) => { … })` that sets `c.set("user", …)`), add another middleware that applies `injectAllowedInboxes` to the same routes that require a resolved session. The cleanest placement is directly after the existing session middleware:

```typescript
app.use("/api/*", async (c, next) => {
  if (
    c.req.path.startsWith("/api/auth") ||
    c.req.path.startsWith("/api/setup") ||
    c.req.path.startsWith("/api/invites") ||
    c.req.path === "/api/health" ||
    c.req.path === "/api/config"
  ) {
    return next();
  }
  return injectAllowedInboxes(c, next);
});
```

- [ ] **Step 4: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add worker/src/variables.ts worker/src/middleware/inject-allowed-inboxes.ts worker/src/index.ts
git commit -m "feat: inject allowedInboxes into request context"
```

---

### Task 5: Admin inboxes router (with tests)

**Files:**

- Create: `worker/src/routers/admin-inboxes-router.ts`
- Create: `worker/src/__tests__/admin-inboxes-router.test.ts`
- Modify: `worker/src/index.ts` — mount new router under admin guard; remove sender-identities mount (done in Task 12)

- [ ] **Step 1: Write failing tests**

Create `worker/src/__tests__/admin-inboxes-router.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { senderIdentities } from "../db/sender-identities.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { eq } from "drizzle-orm";

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("admin inboxes router", () => {
  it("lists inboxes from emails.recipient ∪ sender_identities", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "b@x.com",
      displayName: "Bee",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch("/api/admin/inboxes", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      email: string;
      displayName: string | null;
      assignedUserIds: string[];
    }>;
    const emails = body.map((b) => b.email).sort();
    expect(emails).toEqual(["a@x.com", "b@x.com"]);
  });

  it("returns 403 for non-admin caller", async () => {
    const { apiKey } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    const res = await authFetch("/api/admin/inboxes", { apiKey });
    expect(res.status).toBe(403);
  });

  it("PATCH upserts display name into sender_identities", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: "Alpha" }),
      },
    );
    expect(res.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows[0].displayName).toBe("Alpha");
  });

  it("PATCH clears display name when null is provided", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: "Alpha",
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
    expect(rows).toHaveLength(0);
  });

  it("PUT assignments replaces the full member set", async () => {
    const { apiKey } = await createTestUser({
      id: "u-admin",
      role: "admin",
      email: "admin@x.com",
    });
    await createTestUser({ id: "u-m1", role: "member", email: "m1@x.com" });
    await createTestUser({ id: "u-m2", role: "member", email: "m2@x.com" });
    await createTestUser({ id: "u-m3", role: "member", email: "m3@x.com" });
    // Pre-seed an existing assignment that should be removed.
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(inboxPermissions).values({
      userId: "u-m3",
      email: "a@x.com",
      createdAt: now,
      createdBy: "u-admin",
    });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}/assignments`,
      {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ userIds: ["u-m1", "u-m2"] }),
      },
    );
    expect(res.status).toBe(200);

    const rows = await getDb()
      .select()
      .from(inboxPermissions)
      .where(eq(inboxPermissions.email, "a@x.com"));
    const userIds = rows.map((r) => r.userId).sort();
    expect(userIds).toEqual(["u-m1", "u-m2"]);
  });
});
```

Note: this test uses a new helper `createTestUser({ id, role, email })` — the existing helper already accepts all three.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test worker/src/__tests__/admin-inboxes-router.test.ts`
Expected: failures on 404 (router not mounted yet).

- [ ] **Step 3: Implement the router**

Create `worker/src/routers/admin-inboxes-router.ts`:

```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { senderIdentities } from "../db/sender-identities.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { emails } from "../db/emails.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const adminInboxesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const InboxRowSchema = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  assignedUserIds: z.array(z.string()),
});

const listInboxesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin Inboxes"],
  description:
    "List all known inboxes (from received emails + sender_identities), with display name and assigned members.",
  responses: {
    ...json200Response(z.array(InboxRowSchema), "List of inboxes"),
  },
});

adminInboxesRouter.openapi(listInboxesRoute, async (c) => {
  const db = c.get("db");
  type Row = {
    email: string;
    displayName: string | null;
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
      assignedUserIds: r.assignedUserIds ? JSON.parse(r.assignedUserIds) : [],
    })),
    200,
  );
});

const patchInboxRoute = createRoute({
  method: "patch",
  path: "/{email}",
  tags: ["Admin Inboxes"],
  description: "Update display name for an inbox. Null clears it.",
  request: {
    params: z.object({ email: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            displayName: z.string().nullable(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(
      z.object({ email: z.string(), displayName: z.string().nullable() }),
      "Updated",
    ),
  },
});

adminInboxesRouter.openapi(patchInboxRoute, async (c) => {
  const db = c.get("db");
  const { email } = c.req.valid("param");
  const { displayName } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  if (displayName === null || displayName === "") {
    await db.delete(senderIdentities).where(eq(senderIdentities.email, email));
    return c.json({ email, displayName: null }, 200);
  }

  await db
    .insert(senderIdentities)
    .values({ email, displayName, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: senderIdentities.email,
      set: { displayName, updatedAt: now },
    });

  return c.json({ email, displayName }, 200);
});

const putAssignmentsRoute = createRoute({
  method: "put",
  path: "/{email}/assignments",
  tags: ["Admin Inboxes"],
  description:
    "Replace the full set of member user IDs assigned to this inbox.",
  request: {
    params: z.object({ email: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ userIds: z.array(z.string()) }),
        },
      },
    },
  },
  responses: {
    ...json200Response(
      z.object({ email: z.string(), assignedUserIds: z.array(z.string()) }),
      "Assignments replaced",
    ),
  },
});

adminInboxesRouter.openapi(putAssignmentsRoute, async (c) => {
  const db = c.get("db");
  const currentUser = c.get("user");
  const { email } = c.req.valid("param");
  const { userIds } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  await db.delete(inboxPermissions).where(eq(inboxPermissions.email, email));
  if (userIds.length > 0) {
    await db.insert(inboxPermissions).values(
      userIds.map((userId) => ({
        userId,
        email,
        createdAt: now,
        createdBy: currentUser.id,
      })),
    );
  }
  return c.json({ email, assignedUserIds: userIds }, 200);
});

const listUserInboxesRoute = createRoute({
  method: "get",
  path: "/users/{id}/inboxes",
  tags: ["Admin Inboxes"],
  description: "List inboxes assigned to a specific user.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(z.array(z.string()), "List of inbox addresses"),
  },
});

adminInboxesRouter.openapi(listUserInboxesRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const rows = await db
    .select({ email: inboxPermissions.email })
    .from(inboxPermissions)
    .where(eq(inboxPermissions.userId, id));
  return c.json(
    rows.map((r) => r.email),
    200,
  );
});
```

- [ ] **Step 4: Mount the router (admin-guarded) in index.ts**

Open `worker/src/index.ts`. Add an import:

```typescript
import { adminInboxesRouter } from "./routers/admin-inboxes-router";
```

Mount it under the existing admin guard block. Change:

```typescript
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", adminRouter);
```

To:

```typescript
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", adminRouter);
app.route("/api/admin/inboxes", adminInboxesRouter);
```

**Note:** there is a second admin route under `/api/admin/inboxes/users/:id/inboxes` for user-lookup convenience. That path sits under `/api/admin/*` so the guard still applies.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test worker/src/__tests__/admin-inboxes-router.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/routers/admin-inboxes-router.ts worker/src/index.ts worker/src/__tests__/admin-inboxes-router.test.ts
git commit -m "feat: add admin inboxes router"
```

---

### Task 6: Apply scoping to stats router (with tests)

**Files:**

- Modify: `worker/src/routers/stats-router.ts`

- [ ] **Step 1: Write failing test**

Create `worker/src/__tests__/inbox-scoping.test.ts` (shared test file we extend in later tasks):

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";

async function grantInbox(userId: string, email: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
}

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("stats scoping", () => {
  it("admin sees all recipients and totals", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson({ id: "p1" });
    await createTestPerson({ id: "p2", email: "alice2@example.com" });
    await createTestEmail({ id: "e1", personId: "p1", recipient: "a@x.com" });
    await createTestEmail({
      id: "e2",
      personId: "p2",
      recipient: "b@x.com",
      messageId: "m2",
    });
    const res = await authFetch("/api/stats", { apiKey });
    const body = (await res.json()) as {
      totalEmails: number;
      recipients: string[];
    };
    expect(body.totalEmails).toBe(2);
    expect(body.recipients.sort()).toEqual(["a@x.com", "b@x.com"]);
  });

  it("member sees only assigned recipients and counts", async () => {
    await createTestUser({ id: "u-admin", role: "admin" });
    const { apiKey, userId } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await createTestPerson({ id: "p1" });
    await createTestEmail({ id: "e1", personId: "p1", recipient: "a@x.com" });
    await createTestEmail({
      id: "e2",
      personId: "p1",
      recipient: "b@x.com",
      messageId: "m2",
    });
    await grantInbox(userId, "a@x.com");
    const res = await authFetch("/api/stats", { apiKey });
    const body = (await res.json()) as {
      totalEmails: number;
      recipients: string[];
    };
    expect(body.totalEmails).toBe(1);
    expect(body.recipients).toEqual(["a@x.com"]);
  });

  it("member with zero inboxes sees empty stats", async () => {
    const { apiKey } = await createTestUser({ id: "u-mem", role: "member" });
    await createTestPerson({ id: "p1" });
    await createTestEmail({ id: "e1", personId: "p1", recipient: "a@x.com" });
    const res = await authFetch("/api/stats", { apiKey });
    const body = (await res.json()) as {
      totalEmails: number;
      recipients: string[];
    };
    expect(body.totalEmails).toBe(0);
    expect(body.recipients).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (member cases fail)**

Run: `yarn test worker/src/__tests__/inbox-scoping.test.ts -t "stats"`
Expected: the admin test passes; both member tests fail because scoping is not yet applied.

- [ ] **Step 3: Apply the filter in stats-router**

Replace the handler in `worker/src/routers/stats-router.ts`:

```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, sql, inArray } from "drizzle-orm";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { json200Response } from "../lib/helpers";
import { inboxFilter } from "../lib/inbox-permissions";
import type { Variables } from "../variables";

export const statsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const StatsSchema = z.object({
  totalPeople: z.number(),
  totalEmails: z.number(),
  unreadCount: z.number(),
  recipients: z.array(z.string()),
  senderIdentities: z.array(
    z.object({ email: z.string(), displayName: z.string() }),
  ),
});

const statsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Stats"],
  description:
    "Get inbox statistics (filtered to caller's accessible inboxes).",
  request: {
    query: z.object({
      recipient: z.string().optional(),
    }),
  },
  responses: { ...json200Response(StatsSchema, "Inbox statistics") },
});

statsRouter.openapi(statsRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { recipient } = c.req.valid("query");

  const scopeFilter = inboxFilter(allowed, emails.recipient);
  const recipientFilter = recipient
    ? sql`${emails.recipient} = ${recipient}`
    : undefined;

  const whereEmails = and(scopeFilter, recipientFilter);

  const emailAgg = await db
    .select({
      total: sql<number>`COUNT(*)`,
      unread: sql<number>`SUM(CASE WHEN ${emails.isRead} = 0 THEN 1 ELSE 0 END)`,
    })
    .from(emails)
    .where(whereEmails ?? sql`1=1`);
  const totalEmails = emailAgg[0]?.total ?? 0;
  const unreadCount = emailAgg[0]?.unread ?? 0;

  // People count: restricted to people with ≥1 email in an allowed inbox.
  const personCountRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(people)
    .where(
      allowed.isAdmin
        ? sql`1=1`
        : allowed.inboxes.length === 0
          ? sql`0`
          : sql`${people.id} IN (SELECT person_id FROM ${emails} WHERE ${emails.recipient} IN ${allowed.inboxes})`,
    );

  // Recipients list: restricted too.
  const recipientRows = await db
    .select({ recipient: emails.recipient })
    .from(emails)
    .where(scopeFilter ?? sql`1=1`)
    .groupBy(emails.recipient);

  // Sender identities: filtered to allowed inboxes.
  const allIdentities = await db.select().from(senderIdentities);
  const identityRows = allowed.isAdmin
    ? allIdentities
    : allIdentities.filter((r) => allowed.inboxes.includes(r.email));

  return c.json(
    {
      totalPeople: personCountRow[0]?.count ?? 0,
      totalEmails,
      unreadCount,
      recipients: recipientRows.map((r) => r.recipient),
      senderIdentities: identityRows.map((r) => ({
        email: r.email,
        displayName: r.displayName,
      })),
    },
    200,
  );
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test worker/src/__tests__/inbox-scoping.test.ts -t "stats"`
Expected: all three stats tests pass.

- [ ] **Step 5: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/routers/stats-router.ts worker/src/__tests__/inbox-scoping.test.ts
git commit -m "feat: scope stats endpoint to allowed inboxes"
```

---

### Task 7: Apply scoping to emails router (with tests)

**Files:**

- Modify: `worker/src/routers/emails-router.ts`
- Modify: `worker/src/__tests__/inbox-scoping.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `worker/src/__tests__/inbox-scoping.test.ts`:

```typescript
describe("emails scoping", () => {
  it("member listing by-person excludes disallowed recipients", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await createTestPerson({ id: "p1" });
    await createTestEmail({ id: "e1", personId: "p1", recipient: "a@x.com" });
    await createTestEmail({
      id: "e2",
      personId: "p1",
      recipient: "b@x.com",
      messageId: "m2",
    });
    await grantInbox(userId, "a@x.com");
    const res = await authFetch("/api/emails/by-person/p1", { apiKey });
    const body = (await res.json()) as Array<{ recipient: string }>;
    const recipients = body.map((e) => e.recipient);
    expect(recipients).toEqual(["a@x.com"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test worker/src/__tests__/inbox-scoping.test.ts -t "emails scoping"`
Expected: fails — member sees both recipients.

- [ ] **Step 3: Apply scoping in emails-router**

In `worker/src/routers/emails-router.ts`:

1. Import helpers at the top of the file:

```typescript
import { inboxFilter } from "../lib/inbox-permissions";
```

2. In every handler that queries `emails` (listPersonEmails, sent-email lookups, search, detail), grab `const allowed = c.get("allowedInboxes")!;` and add `inboxFilter(allowed, emails.recipient)` to the `conditions` array alongside the existing filters. For sent-email queries, use `inboxFilter(allowed, sentEmails.fromAddress)`.

Concretely, in the `listPersonEmails` handler, change:

```typescript
const receivedConditions: any[] = [eq(emails.personId, personId)];
if (q) {
  receivedConditions.push(like(emails.subject, `%${escapeLike(q)}%`));
}
if (recipient) {
  receivedConditions.push(eq(emails.recipient, recipient));
}
```

To:

```typescript
const allowed = c.get("allowedInboxes")!;
const receivedConditions: any[] = [eq(emails.personId, personId)];
if (q) {
  receivedConditions.push(like(emails.subject, `%${escapeLike(q)}%`));
}
if (recipient) {
  receivedConditions.push(eq(emails.recipient, recipient));
}
const recvScope = inboxFilter(allowed, emails.recipient);
if (recvScope) receivedConditions.push(recvScope);
```

Apply the same pattern to the parallel sent-email conditions (`sentConditions`) using `inboxFilter(allowed, sentEmails.fromAddress)`.

3. For single-email GET handlers (`GET /api/emails/:id`, message detail), after fetching the row, check:

```typescript
const allowed = c.get("allowedInboxes")!;
if (
  !allowed.isAdmin &&
  row.recipient &&
  !allowed.inboxes.includes(row.recipient)
) {
  return c.json({ error: "Not found" }, 404);
}
```

For sent email detail, check `row.fromAddress` instead.

- [ ] **Step 4: Run tests**

Run: `yarn test worker/src/__tests__/inbox-scoping.test.ts -t "emails scoping"`
Expected: passes.

- [ ] **Step 5: Run full test suite to catch regressions**

Run: `yarn test`
Expected: all tests pass.

- [ ] **Step 6: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/routers/emails-router.ts worker/src/__tests__/inbox-scoping.test.ts
git commit -m "feat: scope emails endpoints to allowed inboxes"
```

---

### Task 8: Apply scoping to people router (with tests)

**Files:**

- Modify: `worker/src/routers/people-router.ts`
- Modify: `worker/src/__tests__/inbox-scoping.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `inbox-scoping.test.ts`:

```typescript
describe("people scoping", () => {
  it("member people list only includes people with emails in allowed inboxes", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await createTestPerson({ id: "p1", email: "a1@external.com" });
    await createTestPerson({ id: "p2", email: "a2@external.com" });
    // p1 has email to a@x.com; p2 has email only to b@x.com
    await createTestEmail({ id: "e1", personId: "p1", recipient: "a@x.com" });
    await createTestEmail({
      id: "e2",
      personId: "p2",
      recipient: "b@x.com",
      messageId: "m2",
    });
    await grantInbox(userId, "a@x.com");
    const res = await authFetch("/api/people", { apiKey });
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((p) => p.id);
    expect(ids).toEqual(["p1"]);
  });

  it("member detail GET for disallowed person returns 404", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await createTestPerson({ id: "p1" });
    await createTestPerson({ id: "p2", email: "a2@external.com" });
    await createTestEmail({ id: "e1", personId: "p1", recipient: "a@x.com" });
    await createTestEmail({
      id: "e2",
      personId: "p2",
      recipient: "b@x.com",
      messageId: "m2",
    });
    await grantInbox(userId, "a@x.com");
    const res = await authFetch("/api/people/p2", { apiKey });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test -t "people scoping"`
Expected: fails.

- [ ] **Step 3: Apply scoping in people-router**

Open `worker/src/routers/people-router.ts`.

1. Add this scoping helper at the top (after imports):

```typescript
import { inboxFilter } from "../lib/inbox-permissions";
import type { AllowedInboxes } from "../lib/inbox-permissions";

function peopleScopeClause(allowed: AllowedInboxes) {
  if (allowed.isAdmin) return sql``;
  if (allowed.inboxes.length === 0)
    return sql`AND s.id IN (SELECT NULL WHERE 0)`;
  return sql`AND s.id IN (SELECT person_id FROM emails WHERE recipient IN ${allowed.inboxes})`;
}
```

Note: the SQL in people-router uses raw `sql` template literals, so we thread this clause into the generated SQL rather than using `inboxFilter`.

2. In BOTH `listGroupedPeopleRoute` and `listPeopleRoute` handlers, replace the `whereClause` assignment. Always start with `WHERE 1=1` so both the user-filter conditions and the scope clause append cleanly.

Replace:

```typescript
const whereClause =
  conditions.length > 0
    ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
    : sql``;
```

With:

```typescript
const allowed = c.get("allowedInboxes")!;
const scopeClause = peopleScopeClause(allowed);
const extraConditions =
  conditions.length > 0 ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``;
const whereClause = sql`WHERE 1=1 ${extraConditions} ${scopeClause}`;
```

No changes are needed at the `${whereClause}` call sites in each route's SQL (main query + count) — the new `whereClause` fits in the same slot.

3. In `getPersonRoute` handler, after fetching the row, add:

```typescript
const allowed = c.get("allowedInboxes")!;
if (!allowed.isAdmin) {
  if (allowed.inboxes.length === 0) {
    return c.json({ error: "Person not found" }, 404);
  }
  const match = await db
    .select({ id: emails.id })
    .from(emails)
    .where(
      and(eq(emails.personId, id), inArray(emails.recipient, allowed.inboxes)),
    )
    .limit(1);
  if (match.length === 0) {
    return c.json({ error: "Person not found" }, 404);
  }
}
```

Add `emails` and `inArray` to imports if not already present.

- [ ] **Step 4: Run tests**

Run: `yarn test -t "people scoping"`
Expected: passes.

- [ ] **Step 5: Full test suite**

Run: `yarn test`
Expected: all tests pass.

- [ ] **Step 6: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/routers/people-router.ts worker/src/__tests__/inbox-scoping.test.ts
git commit -m "feat: scope people endpoints to allowed inboxes"
```

---

### Task 9: Guard send + reply endpoints (with tests)

**Files:**

- Modify: `worker/src/routers/send-router.ts`
- Modify: `worker/src/__tests__/inbox-scoping.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `inbox-scoping.test.ts`:

```typescript
describe("send scoping", () => {
  it("member cannot send from a disallowed inbox", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await grantInbox(userId, "a@x.com");
    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        to: "target@external.com",
        fromAddress: "b@x.com",
        subject: "hi",
        bodyHtml: "<p>hi</p>",
      }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test -t "send scoping"`
Expected: fails (non-403 response).

- [ ] **Step 3: Add guards**

Open `worker/src/routers/send-router.ts`.

Add import:

```typescript
import { assertInboxAllowed } from "../lib/inbox-permissions";
```

In the compose handler (`sendRouter.openapi(sendEmailRoute, …)`), immediately after parsing the body, add:

```typescript
const allowed = c.get("allowedInboxes")!;
assertInboxAllowed(allowed, fromAddress);
```

In the reply handler (`sendRouter.openapi(replyEmailRoute, …)`), immediately after parsing the body, add the same two lines.

`assertInboxAllowed` throws an `HTTPException(403)` which Hono converts into a 403 JSON response automatically.

- [ ] **Step 4: Run tests**

Run: `yarn test -t "send scoping"`
Expected: passes.

- [ ] **Step 5: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/routers/send-router.ts worker/src/__tests__/inbox-scoping.test.ts
git commit -m "feat: enforce inbox permission on send and reply"
```

---

### Task 10: Apply scoping to sequences router (with tests)

**Files:**

- Modify: `worker/src/routers/sequences-router.ts`
- Modify: `worker/src/__tests__/inbox-scoping.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `inbox-scoping.test.ts`:

```typescript
describe("sequences scoping", () => {
  it("member cannot enroll person using disallowed fromAddress", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await grantInbox(userId, "a@x.com");
    // Seed a sequence and a person.
    await createTestPerson({ id: "p1" });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.run(sql`
      INSERT INTO sequences (id, name, steps, created_at, updated_at)
      VALUES ('s1', 'seq', '[]', ${now}, ${now})
    `);
    const res = await authFetch("/api/sequences/s1/enroll", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        personId: "p1",
        fromAddress: "b@x.com",
      }),
    });
    expect(res.status).toBe(403);
  });
});
```

Add import at the top of `inbox-scoping.test.ts` if missing:

```typescript
import { sql } from "drizzle-orm";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test -t "sequences scoping"`
Expected: fails.

- [ ] **Step 3: Apply guard to enrollment**

Open `worker/src/routers/sequences-router.ts`.

Add import:

```typescript
import { assertInboxAllowed, inboxFilter } from "../lib/inbox-permissions";
```

In the `enrollRoute` handler, after parsing the body, add:

```typescript
const allowed = c.get("allowedInboxes")!;
assertInboxAllowed(allowed, fromAddress);
```

(The filter on list/detail views is intentionally not added here because sequences themselves don't have a `fromAddress` column — only enrollments do. Filtering the sequence list by whether a sequence has any enrollments in allowed inboxes is an acceptable future refinement but not required by the spec.)

For enrollment-listing endpoints (if any expose enrollments): filter rows by `inboxFilter(allowed, sequenceEnrollments.fromAddress)`. Search for handlers in the file that `select().from(sequenceEnrollments)` and add `inboxFilter(allowed, sequenceEnrollments.fromAddress)` into their WHERE.

- [ ] **Step 4: Run tests**

Run: `yarn test -t "sequences scoping"`
Expected: passes.

- [ ] **Step 5: Full suite**

Run: `yarn test`
Expected: all pass.

- [ ] **Step 6: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/routers/sequences-router.ts worker/src/__tests__/inbox-scoping.test.ts
git commit -m "feat: enforce inbox permission on sequence enrollment"
```

---

### Task 11: Apply scoping to email-templates router (with tests)

**Files:**

- Modify: `worker/src/routers/email-templates-router.ts`
- Modify: `worker/src/__tests__/inbox-scoping.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `inbox-scoping.test.ts`:

```typescript
describe("templates scoping", () => {
  it("member sees global (from_address IS NULL) and their own inbox templates", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await grantInbox(userId, "a@x.com");
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.run(sql`
      INSERT INTO email_templates (id, slug, name, subject, body_html, from_address, created_at, updated_at)
      VALUES
        ('t-g', 'global', 'Global', 'Hi', '<p/>', NULL, ${now}, ${now}),
        ('t-a', 'a-only', 'A', 'Hi', '<p/>', 'a@x.com', ${now}, ${now}),
        ('t-b', 'b-only', 'B', 'Hi', '<p/>', 'b@x.com', ${now}, ${now})
    `);
    const res = await authFetch("/api/email-templates", { apiKey });
    const body = (await res.json()) as Array<{ slug: string }>;
    const slugs = body.map((t) => t.slug).sort();
    expect(slugs).toEqual(["a-only", "global"]);
  });

  it("member cannot create template with disallowed from_address", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await grantInbox(userId, "a@x.com");
    const res = await authFetch("/api/email-templates", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        slug: "new-one",
        name: "X",
        subject: "X",
        bodyHtml: "<p/>",
        fromAddress: "b@x.com",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("member cannot send template through disallowed from_address", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await grantInbox(userId, "a@x.com");
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.run(sql`
      INSERT INTO email_templates (id, slug, name, subject, body_html, from_address, created_at, updated_at)
      VALUES ('t-g', 'global', 'G', 'Hi', '<p/>', NULL, ${now}, ${now})
    `);
    const res = await authFetch("/api/email-templates/global/send", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        to: "target@external.com",
        fromAddress: "b@x.com",
        variables: {},
      }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test -t "templates scoping"`
Expected: fails.

- [ ] **Step 3: Apply scoping**

Open `worker/src/routers/email-templates-router.ts`.

Add imports:

```typescript
import { and, isNull, or, inArray } from "drizzle-orm";
import { assertInboxAllowed } from "../lib/inbox-permissions";
```

Extend the create schema to accept `fromAddress`:

```typescript
schema: z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  subject: z.string(),
  bodyHtml: z.string(),
  fromAddress: z.string().email().nullable().optional(),
}),
```

In the create handler, after parsing the body:

```typescript
const allowed = c.get("allowedInboxes")!;
if (fromAddress != null) {
  assertInboxAllowed(allowed, fromAddress);
} else if (!allowed.isAdmin) {
  // Members cannot create global (null) templates.
  return c.json({ error: "from_address is required for members" }, 403);
}
```

Persist `fromAddress` in the insert `values`:

```typescript
fromAddress: fromAddress ?? null,
```

In the update handler, if the body includes `fromAddress`, re-run `assertInboxAllowed` against the new value.

In the list handler, add scope filter:

```typescript
const allowed = c.get("allowedInboxes")!;
let rows;
if (allowed.isAdmin) {
  rows = await db.select().from(emailTemplates);
} else if (allowed.inboxes.length === 0) {
  rows = await db
    .select()
    .from(emailTemplates)
    .where(isNull(emailTemplates.fromAddress));
} else {
  rows = await db
    .select()
    .from(emailTemplates)
    .where(
      or(
        isNull(emailTemplates.fromAddress),
        inArray(emailTemplates.fromAddress, allowed.inboxes),
      ),
    );
}
return c.json(rows, 200);
```

In the single-template GET handler, after fetching the row, enforce visibility:

```typescript
const allowed = c.get("allowedInboxes")!;
if (!allowed.isAdmin && rows[0].fromAddress !== null) {
  if (!allowed.inboxes.includes(rows[0].fromAddress)) {
    return c.json({ error: "Template not found" }, 404);
  }
}
```

In the send handler (`sendTemplateRoute`), after parsing the body:

```typescript
const allowed = c.get("allowedInboxes")!;
assertInboxAllowed(allowed, fromAddress);
```

Update the response schema `EmailTemplateSchema` to include the new column:

```typescript
const EmailTemplateSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  subject: z.string(),
  bodyHtml: z.string(),
  fromAddress: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
```

- [ ] **Step 4: Run tests**

Run: `yarn test -t "templates scoping"`
Expected: passes.

- [ ] **Step 5: Full suite**

Run: `yarn test`
Expected: all pass.

- [ ] **Step 6: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/routers/email-templates-router.ts worker/src/__tests__/inbox-scoping.test.ts
git commit -m "feat: scope email templates to allowed inboxes"
```

---

### Task 12: Delete sender-identities router

**Files:**

- Delete: `worker/src/routers/sender-identities-router.ts`
- Modify: `worker/src/index.ts`
- Delete: test file for that router if one exists

- [ ] **Step 1: Verify no direct consumers beyond index.ts**

Run: `yarn tsc --noEmit` then search for imports:

```bash
grep -R "sender-identities-router" worker/src
```

Expected: only `worker/src/index.ts`.

- [ ] **Step 2: Remove mount + import from index.ts**

Open `worker/src/index.ts`.

Remove:

```typescript
import { senderIdentitiesRouter } from "./routers/sender-identities-router";
```

And:

```typescript
app.route("/api/sender-identities", senderIdentitiesRouter);
```

- [ ] **Step 3: Delete the router file**

```bash
git rm worker/src/routers/sender-identities-router.ts
```

Also check `worker/src/__tests__/` for a corresponding test file and delete it:

```bash
ls worker/src/__tests__ | grep sender-identities
# If any exist, remove them:
# git rm worker/src/__tests__/sender-identities-router.test.ts
```

- [ ] **Step 4: Run full test suite**

Run: `yarn test`
Expected: all pass (or only the removed tests are missing).

- [ ] **Step 5: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.ts
git commit -m "refactor: remove /api/sender-identities router (superseded by admin inboxes)"
```

---

### Task 13: Frontend — rename page, route, and sidebar

**Files:**

- Create: `src/pages/InboxesPage.tsx` (placeholder to be filled in Task 14)
- Delete: `src/pages/SettingsPage.tsx`
- Delete: `src/components/SenderIdentitiesSettings.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Create placeholder InboxesPage**

Create `src/pages/InboxesPage.tsx`:

```tsx
export default function InboxesPage() {
  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-lg font-semibold text-text-primary mb-6">Inboxes</h1>
      <p className="text-text-secondary">Coming soon.</p>
    </div>
  );
}
```

(Filled out with the real table in Task 14.)

- [ ] **Step 2: Update App.tsx routes**

Open `src/App.tsx`.

Replace:

```tsx
import SettingsPage from "./pages/SettingsPage";
```

With:

```tsx
import InboxesPage from "./pages/InboxesPage";
```

Replace:

```tsx
<Route path="/settings" element={<SettingsPage />} />
```

With:

```tsx
<Route path="/inboxes" element={<InboxesPage />} />
<Route path="/settings" element={<Navigate to="/inboxes" replace />} />
```

- [ ] **Step 3: Update Sidebar**

Open `src/components/Sidebar.tsx`.

Change the nav item for Settings from:

```tsx
{ icon: Settings, label: "Settings", path: "/settings" },
```

To:

```tsx
{ icon: Settings, label: "Inboxes", path: "/inboxes", adminOnly: true },
```

- [ ] **Step 4: Delete the old files**

```bash
git rm src/pages/SettingsPage.tsx src/components/SenderIdentitiesSettings.tsx
```

- [ ] **Step 5: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors. If the delete breaks any imports in `src/`, remove those imports. (The file should have no other consumers — the settings page was the only one.)

- [ ] **Step 6: Commit**

```bash
git add src/pages/InboxesPage.tsx src/App.tsx src/components/Sidebar.tsx
git commit -m "feat: rename settings page to inboxes (admin only)"
```

---

### Task 14: Frontend — admin inboxes table

**Files:**

- Create: `src/components/AdminInboxTable.tsx`
- Modify: `src/pages/InboxesPage.tsx`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add API helpers**

Open `src/lib/api.ts`.

Delete the existing sender-identities helpers (`fetchSenderIdentities`, `upsertSenderIdentity`, `deleteSenderIdentity`, and the `SenderIdentity` interface if it's only used here).

Add:

```typescript
export interface AdminInbox {
  email: string;
  displayName: string | null;
  assignedUserIds: string[];
}

export async function fetchAdminInboxes(): Promise<AdminInbox[]> {
  return apiFetch("/api/admin/inboxes");
}

export async function updateInboxDisplayName(
  email: string,
  displayName: string | null,
): Promise<{ email: string; displayName: string | null }> {
  return apiFetch(`/api/admin/inboxes/${encodeURIComponent(email)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
}

export async function updateInboxAssignments(
  email: string,
  userIds: string[],
): Promise<{ email: string; assignedUserIds: string[] }> {
  return apiFetch(
    `/api/admin/inboxes/${encodeURIComponent(email)}/assignments`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds }),
    },
  );
}
```

If `fetchAdminUsers` is not already present, add a minimal one:

```typescript
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string | null;
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  return apiFetch("/api/admin/users");
}
```

(Check `src/lib/api.ts` first — if there's already a user-admin helper, reuse its signature.)

- [ ] **Step 2: Create AdminInboxTable component**

Create `src/components/AdminInboxTable.tsx`:

```tsx
import { useEffect, useState } from "react";
import {
  fetchAdminInboxes,
  fetchAdminUsers,
  updateInboxAssignments,
  updateInboxDisplayName,
  type AdminInbox,
  type AdminUser,
} from "@/lib/api";

export default function AdminInboxTable() {
  const [inboxes, setInboxes] = useState<AdminInbox[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchAdminInboxes(), fetchAdminUsers()]).then(([i, u]) => {
      setInboxes(i);
      setUsers(u);
      setLoading(false);
    });
  }, []);

  const members = users.filter((u) => u.role !== "admin");

  async function handleNameBlur(inbox: AdminInbox, value: string) {
    const next = value.trim() === "" ? null : value.trim();
    if (next === inbox.displayName) return;
    const res = await updateInboxDisplayName(inbox.email, next);
    setInboxes((prev) =>
      prev.map((r) =>
        r.email === inbox.email ? { ...r, displayName: res.displayName } : r,
      ),
    );
  }

  async function handleToggleAssignment(inbox: AdminInbox, userId: string) {
    const has = inbox.assignedUserIds.includes(userId);
    const nextIds = has
      ? inbox.assignedUserIds.filter((x) => x !== userId)
      : [...inbox.assignedUserIds, userId];
    const res = await updateInboxAssignments(inbox.email, nextIds);
    setInboxes((prev) =>
      prev.map((r) =>
        r.email === inbox.email
          ? { ...r, assignedUserIds: res.assignedUserIds }
          : r,
      ),
    );
  }

  if (loading) {
    return <p className="text-text-secondary">Loading…</p>;
  }

  if (inboxes.length === 0) {
    return (
      <p className="text-text-secondary">
        No inboxes yet. Once you receive email, inboxes will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {inboxes.map((inbox) => (
        <div
          key={inbox.email}
          className="rounded-lg border border-border-dark bg-card p-4"
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex-1">
              <div className="text-sm font-medium text-text-primary">
                {inbox.email}
              </div>
              <input
                type="text"
                defaultValue={inbox.displayName ?? ""}
                placeholder="Display name (optional)"
                onBlur={(e) => handleNameBlur(inbox, e.currentTarget.value)}
                className="mt-1 w-full rounded bg-main px-2 py-1 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          </div>
          <div className="mt-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-text-tertiary">
              Members
            </div>
            <div className="mb-2 text-xs text-text-secondary">
              Admins have access to every inbox automatically.
            </div>
            <div className="flex flex-wrap gap-2">
              {members.map((u) => {
                const on = inbox.assignedUserIds.includes(u.id);
                return (
                  <button
                    key={u.id}
                    onClick={() => handleToggleAssignment(inbox, u.id)}
                    className={`rounded-full px-3 py-1 text-xs ${
                      on
                        ? "bg-accent text-white"
                        : "bg-hover text-text-secondary"
                    }`}
                  >
                    {u.name || u.email}
                  </button>
                );
              })}
              {members.length === 0 && (
                <span className="text-xs text-text-tertiary">
                  No members to assign.
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Wire the table into InboxesPage**

Replace contents of `src/pages/InboxesPage.tsx`:

```tsx
import { useSession } from "@/lib/auth-client";
import { Navigate } from "react-router-dom";
import AdminInboxTable from "@/components/AdminInboxTable";

export default function InboxesPage() {
  const { data: session } = useSession();
  if (session?.user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }
  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-lg font-semibold text-text-primary mb-2">Inboxes</h1>
      <p className="mb-6 text-sm text-text-secondary">
        Set display names and control which members can access each inbox.
      </p>
      <AdminInboxTable />
    </div>
  );
}
```

- [ ] **Step 4: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

Run: `yarn dev` in one terminal; in another, navigate to `/inboxes` after logging in as admin.

Expected:

- Admin: sees table, can edit display name and toggle member chips.
- Member (if you have one): `/inboxes` redirects to `/`.

- [ ] **Step 6: Commit**

```bash
git add src/components/AdminInboxTable.tsx src/pages/InboxesPage.tsx src/lib/api.ts
git commit -m "feat: admin inbox table for display names and member assignments"
```

---

### Task 15: Empty-state for members with no inboxes

**Files:**

- Modify: `src/components/DashboardLayout.tsx` (or wherever the main content area renders; identify during task)

- [ ] **Step 1: Locate main inbox view**

Open `src/pages/InboxPage.tsx` (the default route component). Read the top of the file to understand how it fetches stats and renders the list.

Run:

```bash
grep -R "stats" src/pages/InboxPage.tsx | head -20
```

Note the hook/call that produces `stats.recipients`.

- [ ] **Step 2: Add empty-state branch**

Where the component renders the list of emails (after stats load, before the list itself), insert:

```tsx
if (stats && stats.recipients.length === 0) {
  return (
    <div className="flex flex-1 items-center justify-center p-10 text-center">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">
          No inboxes assigned yet
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          Ask an admin to grant you access to an inbox.
        </p>
      </div>
    </div>
  );
}
```

Adjust the variable name if `stats` is named differently in this file — the test is whether the recipients array from `/api/stats` is empty.

- [ ] **Step 3: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual smoke test**

As a member with zero inboxes, visit `/`. You should see the empty state. Assign an inbox as admin, refresh, the empty state should go away and the inbox list populate.

- [ ] **Step 5: Commit**

```bash
git add src/pages/InboxPage.tsx
git commit -m "feat: empty-state when member has no assigned inboxes"
```

---

### Task 16: Final verification

- [ ] **Step 1: Full test run**

Run: `yarn test`
Expected: all tests pass.

- [ ] **Step 2: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual end-to-end walkthrough**

1. Log in as admin.
2. Visit `/inboxes`. Set display name on one inbox; assign a member to it.
3. Log out; log in as the assigned member.
4. Verify they see only the assigned inbox (sidebar recipient filter, stats, email list, people list).
5. Compose from assigned inbox → works.
6. Try crafting a request to send from an unassigned inbox (via dev tools) → returns 403.
7. Log back in as admin, revoke that member's access, then log in as member and refresh → now sees the empty state.
8. Log in as a member who has zero inboxes from the start — sees the empty state on `/`.

- [ ] **Step 4: Done**

All tasks complete. Branch is ready for review.
