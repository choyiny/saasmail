# User Management Portal & Passkey Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin user management (invite/list/delete users with roles) and enforce passkey-only authentication after initial account setup.

**Architecture:** BetterAuth `passkey()` plugin handles WebAuthn. Custom invitations table + admin API for user management. Frontend `AuthGuard` gates all routes behind passkey registration check. Login page uses passkey-only auth.

**Tech Stack:** `@better-auth/passkey`, `@simplewebauthn/browser` (transitive), Hono + Zod OpenAPI, Drizzle ORM, React + shadcn/ui

---

## File Structure

| File                                   | Responsibility                                               |
| -------------------------------------- | ------------------------------------------------------------ |
| `worker/src/auth/index.ts`             | Add passkey plugin to BetterAuth config                      |
| `worker/src/db/auth.schema.ts`         | Regenerated — adds passkeys table                            |
| `worker/src/db/invitations.schema.ts`  | Custom invitations table (replaces BetterAuth-generated one) |
| `worker/src/db/schema.ts`              | Export invitations schema                                    |
| `worker/src/db/index.ts`               | Re-export invitations                                        |
| `worker/src/routers/admin-router.ts`   | Admin-only endpoints: invite CRUD, user list/delete/role     |
| `worker/src/routers/invites-router.ts` | Public endpoints: validate invite, accept invite             |
| `worker/src/routers/user-router.ts`    | Authenticated user endpoint: passkey status                  |
| `worker/src/index.ts`                  | Mount new routers, add requireAdmin middleware               |
| `src/lib/auth-client.ts`               | Add passkeyClient plugin                                     |
| `src/lib/api.ts`                       | Add invite, user management, passkey status API functions    |
| `src/App.tsx`                          | Add routes, update AuthGuard with passkey check              |
| `src/pages/LoginPage.tsx`              | Replace with passkey-only login                              |
| `src/pages/OnboardingPage.tsx`         | Redirect to /setup-passkey after setup                       |
| `src/pages/InboxPage.tsx`              | Add "Users" nav link for admins                              |
| `src/pages/SetupPasskeyPage.tsx`       | Passkey registration interstitial                            |
| `src/pages/InviteAcceptPage.tsx`       | Invite acceptance + registration form                        |
| `src/pages/AdminUsersPage.tsx`         | User management portal                                       |

---

### Task 1: Install passkey dependency

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install @better-auth/passkey**

Run:

```bash
npm install @better-auth/passkey
```

- [ ] **Step 2: Verify installation**

Run:

```bash
node -e "require('@better-auth/passkey')" && echo "OK"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install @better-auth/passkey"
```

---

### Task 2: Add passkey plugin to BetterAuth server config

**Files:**

- Modify: `worker/src/auth/index.ts`

- [ ] **Step 1: Update auth config to include passkey plugin**

Replace the full contents of `worker/src/auth/index.ts` with:

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, openAPI } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";

export function createAuth(env?: CloudflareBindings) {
  const db = env ? drizzle(env.DB, { schema, logger: true }) : ({} as any);

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    plugins: [admin(), openAPI(), passkey()],
    advanced: {
      cookiePrefix: "cmail",
      defaultCookieAttributes: { sameSite: "lax", secure: true },
    },
    trustedOrigins: ["http://localhost:8080", "https://mail.givefeedback.dev"],
  });
}

export const auth = createAuth();
```

- [ ] **Step 2: Regenerate auth schema to include passkeys table**

Run:

```bash
npx @better-auth/cli generate --config ./worker/src/auth/index.ts --output ./worker/src/db/auth.schema.ts
```

If the CLI doesn't work with that config path, manually add the passkeys table to `worker/src/db/auth.schema.ts`:

```typescript
export const passkeys = sqliteTable("passkeys", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull().unique(),
  counter: integer("counter").notNull().default(0),
  deviceType: text("device_type"),
  backedUp: integer("backed_up", { mode: "boolean" }),
  transports: text("transports"),
  createdAt: integer("created_at", { mode: "timestamp" }),
});
```

- [ ] **Step 3: Generate database migration**

Run:

```bash
npx drizzle-kit generate
```

- [ ] **Step 4: Apply migration locally**

Run:

```bash
npx wrangler d1 migrations apply cmail-db --local
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/auth/index.ts worker/src/db/auth.schema.ts migrations/
git commit -m "feat: add passkey plugin to BetterAuth config"
```

---

### Task 3: Create custom invitations schema

**Files:**

- Create: `worker/src/db/invitations.schema.ts`
- Modify: `worker/src/db/auth.schema.ts` (remove old invitations table)
- Modify: `worker/src/db/schema.ts`
- Modify: `worker/src/db/index.ts`

- [ ] **Step 1: Remove the BetterAuth-generated invitations table from auth.schema.ts**

In `worker/src/db/auth.schema.ts`, delete the entire `invitations` table definition (lines 62-72):

```typescript
// DELETE THIS BLOCK:
export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});
```

- [ ] **Step 2: Create the custom invitations schema**

Create `worker/src/db/invitations.schema.ts`:

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  role: text("role").notNull().default("member"),
  email: text("email"),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedBy: text("used_by"),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
```

- [ ] **Step 3: Update schema barrel to include invitations**

In `worker/src/db/schema.ts`, add the invitations import:

```typescript
import * as authSchema from "./auth.schema";
import { senders } from "./senders.schema";
import { emails } from "./emails.schema";
import { sentEmails } from "./sent-emails.schema";
import { attachments } from "./attachments.schema";
import { emailTemplates } from "./email-templates.schema";
import { invitations } from "./invitations.schema";

export const schema = {
  ...authSchema,
  senders,
  emails,
  sentEmails,
  attachments,
  emailTemplates,
  invitations,
} as const;
```

- [ ] **Step 4: Update db/index.ts re-exports**

In `worker/src/db/index.ts`, add the invitations re-export:

```typescript
export * from "drizzle-orm";
export * from "./auth.schema";
export * from "./senders.schema";
export * from "./emails.schema";
export * from "./sent-emails.schema";
export * from "./attachments.schema";
export * from "./email-templates.schema";
export * from "./invitations.schema";
export * from "./schema";
```

- [ ] **Step 5: Generate and apply migration for the new invitations table**

Run:

```bash
npx drizzle-kit generate
npx wrangler d1 migrations apply cmail-db --local
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/db/invitations.schema.ts worker/src/db/auth.schema.ts worker/src/db/schema.ts worker/src/db/index.ts migrations/
git commit -m "feat: replace BetterAuth invitations with custom invitations schema"
```

---

### Task 4: Create admin router (invite + user management API)

**Files:**

- Create: `worker/src/routers/admin-router.ts`

- [ ] **Step 1: Create the admin router with invite and user management endpoints**

Create `worker/src/routers/admin-router.ts`:

```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { users, passkeys } from "../db/auth.schema";
import { invitations } from "../db/invitations.schema";
import { json200Response, json201Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const adminRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// --- Schemas ---

const InviteSchema = z.object({
  id: z.string(),
  token: z.string(),
  role: z.string(),
  email: z.string().nullable(),
  expiresAt: z.number(),
  usedBy: z.string().nullable(),
  usedAt: z.number().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
});

const CreateInviteSchema = z.object({
  role: z.enum(["admin", "member"]).default("member"),
  email: z.string().email().optional(),
  expiresInDays: z.number().min(1).max(30).default(7),
});

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string().nullable(),
  createdAt: z.number(),
  hasPasskey: z.boolean(),
});

const UpdateRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

const ErrorSchema = z.object({
  error: z.string(),
});

// --- Invite Endpoints ---

const createInviteRoute = createRoute({
  method: "post",
  path: "/invites",
  tags: ["Admin"],
  description: "Create an invitation link for a new user.",
  request: {
    body: {
      content: { "application/json": { schema: CreateInviteSchema } },
    },
  },
  responses: {
    ...json201Response(InviteSchema, "Invite created"),
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRouter.openapi(createInviteRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { role, email, expiresInDays } = c.req.valid("json");

  const now = new Date();
  const invite = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    role,
    email: email ?? null,
    expiresAt: new Date(now.getTime() + expiresInDays * 86400000),
    usedBy: null,
    usedAt: null,
    createdBy: user.id,
    createdAt: now,
  };

  await db.insert(invitations).values(invite);

  return c.json(
    {
      ...invite,
      expiresAt: Math.floor(invite.expiresAt.getTime() / 1000),
      createdAt: Math.floor(invite.createdAt.getTime() / 1000),
      usedAt: null,
    },
    201,
  );
});

const listInvitesRoute = createRoute({
  method: "get",
  path: "/invites",
  tags: ["Admin"],
  description: "List all invitations.",
  responses: {
    ...json200Response(z.array(InviteSchema), "List of invitations"),
  },
});

adminRouter.openapi(listInvitesRoute, async (c) => {
  const db = c.get("db");
  const rows = await db
    .select()
    .from(invitations)
    .orderBy(invitations.createdAt);

  const result = rows.map((row) => ({
    ...row,
    expiresAt:
      row.expiresAt instanceof Date
        ? Math.floor(row.expiresAt.getTime() / 1000)
        : row.expiresAt,
    createdAt:
      row.createdAt instanceof Date
        ? Math.floor(row.createdAt.getTime() / 1000)
        : row.createdAt,
    usedAt:
      row.usedAt instanceof Date
        ? Math.floor(row.usedAt.getTime() / 1000)
        : row.usedAt,
  }));

  return c.json(result, 200);
});

// --- User Management Endpoints ---

const listUsersRoute = createRoute({
  method: "get",
  path: "/users",
  tags: ["Admin"],
  description: "List all users with passkey status.",
  responses: {
    ...json200Response(z.array(UserSchema), "List of users"),
  },
});

adminRouter.openapi(listUsersRoute, async (c) => {
  const db = c.get("db");

  const allUsers = await db.select().from(users);

  const passkeyCountRows = await db
    .select({
      userId: passkeys.userId,
      count: sql<number>`COUNT(*)`,
    })
    .from(passkeys)
    .groupBy(passkeys.userId);

  const passkeyMap = new Map(passkeyCountRows.map((r) => [r.userId, r.count]));

  const result = allUsers.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    createdAt:
      u.createdAt instanceof Date
        ? Math.floor(u.createdAt.getTime() / 1000)
        : u.createdAt,
    hasPasskey: (passkeyMap.get(u.id) ?? 0) > 0,
  }));

  return c.json(result, 200);
});

const updateRoleRoute = createRoute({
  method: "patch",
  path: "/users/{id}/role",
  tags: ["Admin"],
  description: "Update a user's role.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: UpdateRoleSchema } },
    },
  },
  responses: {
    ...json200Response(z.object({ success: z.literal(true) }), "Role updated"),
    400: {
      description: "Cannot change own role",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRouter.openapi(updateRoleRoute, async (c) => {
  const db = c.get("db");
  const currentUser = c.get("user");
  const { id } = c.req.valid("param");
  const { role } = c.req.valid("json");

  if (id === currentUser.id) {
    return c.json({ error: "Cannot change your own role" }, 400);
  }

  const target = await db.select().from(users).where(eq(users.id, id)).get();
  if (!target) {
    return c.json({ error: "User not found" }, 404);
  }

  await db.update(users).set({ role }).where(eq(users.id, id));
  return c.json({ success: true as const }, 200);
});

const deleteUserRoute = createRoute({
  method: "delete",
  path: "/users/{id}",
  tags: ["Admin"],
  description: "Delete a user.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(z.object({ success: z.literal(true) }), "User deleted"),
    400: {
      description: "Cannot delete yourself",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminRouter.openapi(deleteUserRoute, async (c) => {
  const db = c.get("db");
  const currentUser = c.get("user");
  const { id } = c.req.valid("param");

  if (id === currentUser.id) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }

  const target = await db.select().from(users).where(eq(users.id, id)).get();
  if (!target) {
    return c.json({ error: "User not found" }, 404);
  }

  await db.delete(users).where(eq(users.id, id));
  return c.json({ success: true as const }, 200);
});
```

- [ ] **Step 2: Verify the file compiles**

Run:

```bash
npx tsc --noEmit --project worker/tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/routers/admin-router.ts
git commit -m "feat: add admin router with invite and user management endpoints"
```

---

### Task 5: Create public invites router (validate + accept)

**Files:**

- Create: `worker/src/routers/invites-router.ts`

- [ ] **Step 1: Create the public invites router**

Create `worker/src/routers/invites-router.ts`:

```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { users } from "../db/auth.schema";
import { invitations } from "../db/invitations.schema";
import { createAuth } from "../auth";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const invitesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const InviteInfoSchema = z.object({
  valid: z.boolean(),
  role: z.string().optional(),
  email: z.string().nullable().optional(),
});

const AcceptInviteSchema = z.object({
  token: z.string(),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const validateInviteRoute = createRoute({
  method: "get",
  path: "/{token}",
  tags: ["Invites"],
  description: "Check if an invitation token is valid.",
  request: {
    params: z.object({ token: z.string() }),
  },
  responses: {
    ...json200Response(InviteInfoSchema, "Invite status"),
  },
});

invitesRouter.openapi(validateInviteRoute, async (c) => {
  const db = c.get("db");
  const { token } = c.req.valid("param");

  const invite = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .get();

  if (!invite) {
    return c.json({ valid: false }, 200);
  }

  const expiresAt =
    invite.expiresAt instanceof Date
      ? invite.expiresAt
      : new Date((invite.expiresAt as unknown as number) * 1000);
  if (invite.usedBy || expiresAt < new Date()) {
    return c.json({ valid: false }, 200);
  }

  return c.json({ valid: true, role: invite.role, email: invite.email }, 200);
});

const acceptInviteRoute = createRoute({
  method: "post",
  path: "/accept",
  tags: ["Invites"],
  description: "Accept an invitation and create a user account.",
  request: {
    body: {
      content: { "application/json": { schema: AcceptInviteSchema } },
    },
  },
  responses: {
    ...json200Response(
      z.object({ success: z.boolean(), userId: z.string() }),
      "Account created",
    ),
    400: {
      description: "Invalid or expired invite",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

invitesRouter.openapi(acceptInviteRoute, async (c) => {
  const db = c.get("db");
  const { token, name, email, password } = c.req.valid("json");

  const invite = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .get();

  if (!invite) {
    return c.json({ error: "Invalid invitation token" }, 400);
  }

  const expiresAt =
    invite.expiresAt instanceof Date
      ? invite.expiresAt
      : new Date((invite.expiresAt as unknown as number) * 1000);
  if (expiresAt < new Date()) {
    return c.json({ error: "Invitation has expired" }, 400);
  }

  if (invite.usedBy) {
    return c.json({ error: "Invitation has already been used" }, 400);
  }

  if (invite.email && invite.email !== email) {
    return c.json({ error: "Email does not match the invitation" }, 400);
  }

  const auth = createAuth(c.env);

  let newUser;
  try {
    newUser = await auth.api.createUser({
      body: { email, password, name, role: invite.role },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Account creation failed";
    return c.json({ error: message }, 400);
  }

  await db
    .update(invitations)
    .set({ usedBy: newUser.user.id, usedAt: new Date() })
    .where(eq(invitations.token, token));

  return c.json({ success: true, userId: newUser.user.id }, 200);
});
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/routers/invites-router.ts
git commit -m "feat: add public invites router for invite validation and acceptance"
```

---

### Task 6: Create user router (passkey status endpoint)

**Files:**

- Create: `worker/src/routers/user-router.ts`

- [ ] **Step 1: Create the user router**

Create `worker/src/routers/user-router.ts`:

```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { passkeys } from "../db/auth.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const userRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const PasskeyStatusSchema = z.object({
  hasPasskey: z.boolean(),
});

const passkeyStatusRoute = createRoute({
  method: "get",
  path: "/passkeys",
  tags: ["User"],
  description: "Check if the current user has a registered passkey.",
  responses: {
    ...json200Response(PasskeyStatusSchema, "Passkey status"),
  },
});

userRouter.openapi(passkeyStatusRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const rows = await db
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, user.id))
    .limit(1);

  return c.json({ hasPasskey: rows.length > 0 }, 200);
});
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/routers/user-router.ts
git commit -m "feat: add user router with passkey status endpoint"
```

---

### Task 7: Mount new routers and add requireAdmin middleware

**Files:**

- Modify: `worker/src/index.ts`

- [ ] **Step 1: Update index.ts to mount the new routers**

Replace the full contents of `worker/src/index.ts` with:

```typescript
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { injectDb } from "./db/middleware";
import { createAuth } from "./auth";
import { handleEmail } from "./email-handler";
import { sendersRouter } from "./routers/senders-router";
import { emailsRouter } from "./routers/emails-router";
import { sendRouter } from "./routers/send-router";
import { attachmentsRouter } from "./routers/attachments-router";
import { statsRouter } from "./routers/stats-router";
import { setupRouter } from "./routers/setup-router";
import { emailTemplatesRouter } from "./routers/email-templates-router";
import { adminRouter } from "./routers/admin-router";
import { invitesRouter } from "./routers/invites-router";
import { userRouter } from "./routers/user-router";
import type { Variables } from "./variables";
import type { MiddlewareHandler } from "hono";

const app = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// Middleware
app.use("*", injectDb);
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["http://localhost:8080", "https://mail.givefeedback.dev"],
    credentials: true,
  }),
);

// BetterAuth handler
app.all("/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// Session resolution for all API routes
app.use("/api/*", async (c, next) => {
  if (
    c.req.path.startsWith("/api/auth") ||
    c.req.path.startsWith("/api/setup") ||
    c.req.path.startsWith("/api/invites") ||
    c.req.path === "/api/health"
  ) {
    return next();
  }
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", session.user);
  return next();
});

// Admin guard middleware
const requireAdmin: MiddlewareHandler<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}> = async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
};

// API Routes
app.route("/api/senders", sendersRouter);
app.route("/api/emails", emailsRouter);
app.route("/api/send", sendRouter);
app.route("/api/attachments", attachmentsRouter);
app.route("/api/stats", statsRouter);
app.route("/api/setup", setupRouter);
app.route("/api/email-templates", emailTemplatesRouter);
app.route("/api/user", userRouter);
app.route("/api/invites", invitesRouter);

// Admin routes (require admin role)
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", adminRouter);

// Health check (no auth)
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Swagger UI
app.get("/swagger-ui", swaggerUI({ url: "/doc" }));
app.doc("/doc", {
  openapi: "3.0.0",
  info: { title: "cmail API", version: "1.0.0" },
});

// SPA fallback
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  email: handleEmail,
};
```

Key changes:

- Added imports for adminRouter, invitesRouter, userRouter
- Added `/api/invites` to the session bypass list (public endpoints)
- Added `requireAdmin` middleware
- Mounted `/api/user`, `/api/invites`, and `/api/admin` routes

- [ ] **Step 2: Verify the build**

Run:

```bash
npx tsc --noEmit --project worker/tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat: mount admin, invites, and user routers with requireAdmin middleware"
```

---

### Task 8: Update frontend auth client with passkey plugin

**Files:**

- Modify: `src/lib/auth-client.ts`

- [ ] **Step 1: Add passkeyClient to the auth client**

Replace the full contents of `src/lib/auth-client.ts` with:

```typescript
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [adminClient(), passkeyClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/auth-client.ts
git commit -m "feat: add passkeyClient plugin to frontend auth client"
```

---

### Task 9: Add frontend API functions for invites, users, and passkey status

**Files:**

- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add new types and API functions to the end of api.ts**

Append the following to the end of `src/lib/api.ts`:

```typescript
// --- User Management Types ---

export interface Invite {
  id: string;
  token: string;
  role: string;
  email: string | null;
  expiresAt: number;
  usedBy: string | null;
  usedAt: number | null;
  createdBy: string;
  createdAt: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string | null;
  createdAt: number;
  hasPasskey: boolean;
}

export interface InviteInfo {
  valid: boolean;
  role?: string;
  email?: string | null;
}

// --- Admin API ---

export async function createInvite(data: {
  role: "admin" | "member";
  email?: string;
  expiresInDays?: number;
}): Promise<Invite> {
  return apiFetch<Invite>("/api/admin/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function fetchInvites(): Promise<Invite[]> {
  return apiFetch<Invite[]>("/api/admin/invites");
}

export async function fetchUsers(): Promise<User[]> {
  return apiFetch<User[]>("/api/admin/users");
}

export async function updateUserRole(
  id: string,
  role: "admin" | "member",
): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/admin/users/${id}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

export async function deleteUser(id: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/admin/users/${id}`, {
    method: "DELETE",
  });
}

// --- Public Invite API ---

export async function validateInvite(token: string): Promise<InviteInfo> {
  return apiFetch<InviteInfo>(`/api/invites/${token}`);
}

export async function acceptInvite(data: {
  token: string;
  name: string;
  email: string;
  password: string;
}): Promise<{ success: boolean; userId: string }> {
  return apiFetch<{ success: boolean; userId: string }>("/api/invites/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// --- User API ---

export async function fetchPasskeyStatus(): Promise<{ hasPasskey: boolean }> {
  return apiFetch<{ hasPasskey: boolean }>("/api/user/passkeys");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: add invite, user management, and passkey status API functions"
```

---

### Task 10: Create SetupPasskeyPage

**Files:**

- Create: `src/pages/SetupPasskeyPage.tsx`

- [ ] **Step 1: Create the passkey registration interstitial page**

Create `src/pages/SetupPasskeyPage.tsx`:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SetupPasskeyPage() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRegister() {
    setLoading(true);
    setError("");
    try {
      const result = await authClient.passkey.addPasskey();
      if (result?.error) {
        setError(result.error.message || "Passkey registration failed");
      } else {
        window.location.href = "/";
      }
    } catch {
      setError("Passkey registration failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Register a Passkey</CardTitle>
          <p className="text-sm text-neutral-500">
            For security, you must register a passkey before accessing cmail.
            This will be used for all future sign-ins.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button
            className="w-full"
            onClick={handleRegister}
            disabled={loading}
          >
            {loading ? "Registering..." : "Register Passkey"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/SetupPasskeyPage.tsx
git commit -m "feat: add SetupPasskeyPage for mandatory passkey registration"
```

---

### Task 11: Create InviteAcceptPage

**Files:**

- Create: `src/pages/InviteAcceptPage.tsx`

- [ ] **Step 1: Create the invite acceptance page**

Create `src/pages/InviteAcceptPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { signIn } from "@/lib/auth-client";
import { validateInvite, acceptInvite } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<"loading" | "valid" | "invalid">(
    "loading",
  );
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus("invalid");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const info = await validateInvite(token);
        if (cancelled) return;
        if (info.valid) {
          setStatus("valid");
          if (info.email) {
            setInviteEmail(info.email);
            setEmail(info.email);
          }
        } else {
          setStatus("invalid");
        }
      } catch {
        if (!cancelled) setStatus("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const result = await acceptInvite({ token, name, email, password });
      if (!result.success) {
        setError("Failed to create account");
        return;
      }
      // Auto-sign in with the new credentials
      const signInResult = await signIn.email({ email, password });
      if (signInResult.error) {
        setError("Account created but sign-in failed. Please go to login.");
        return;
      }
      window.location.href = "/setup-passkey";
    } catch (err: any) {
      setError(err?.message || "Failed to accept invitation");
    } finally {
      setLoading(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-neutral-500">Validating invitation...</p>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-2xl">Invalid Invitation</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-neutral-600">
              This invitation link is invalid, expired, or has already been
              used.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Join cmail</CardTitle>
          <p className="text-sm text-neutral-500">
            Create your account to get started.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                disabled={!!inviteEmail}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
              <p className="text-xs text-neutral-500">At least 8 characters.</p>
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating account..." : "Create account"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/InviteAcceptPage.tsx
git commit -m "feat: add InviteAcceptPage for invite acceptance and registration"
```

---

### Task 12: Create AdminUsersPage

**Files:**

- Create: `src/pages/AdminUsersPage.tsx`

- [ ] **Step 1: Create the user management portal page**

Create `src/pages/AdminUsersPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useSession } from "@/lib/auth-client";
import {
  fetchUsers,
  fetchInvites,
  createInvite,
  updateUserRole,
  deleteUser,
} from "@/lib/api";
import type { User, Invite } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function AdminUsersPage() {
  const { data: session } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteExpiry, setInviteExpiry] = useState("7");
  const [generatedLink, setGeneratedLink] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  if (session?.user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  async function loadData() {
    setLoading(true);
    try {
      const [u, i] = await Promise.all([fetchUsers(), fetchInvites()]);
      setUsers(u);
      setInvites(i);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleCreateInvite() {
    setInviteLoading(true);
    try {
      const invite = await createInvite({
        role: inviteRole,
        email: inviteEmail || undefined,
        expiresInDays: parseInt(inviteExpiry) || 7,
      });
      const link = `${window.location.origin}/invite/${invite.token}`;
      setGeneratedLink(link);
      setCopied(false);
      await loadData();
    } catch {
      // ignore
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(generatedLink);
    setCopied(true);
  }

  async function handleRoleChange(userId: string, role: "admin" | "member") {
    await updateUserRole(userId, role);
    await loadData();
  }

  async function handleDelete(userId: string) {
    if (!confirm("Are you sure you want to delete this user?")) return;
    await deleteUser(userId);
    await loadData();
  }

  function formatDate(ts: number) {
    return new Date(ts * 1000).toLocaleDateString();
  }

  function inviteStatus(invite: Invite): string {
    if (invite.usedBy) return "used";
    if (invite.expiresAt * 1000 < Date.now()) return "expired";
    return "pending";
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-lg font-semibold">
          <Link to="/">cmail</Link>
        </h1>
        <div className="flex items-center gap-2">
          <Link
            to="/"
            className="text-sm text-neutral-500 hover:text-neutral-700"
          >
            Inbox
          </Link>
          <Link
            to="/templates"
            className="text-sm text-neutral-500 hover:text-neutral-700"
          >
            Templates
          </Link>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {/* Users Section */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Users</CardTitle>
              <Dialog
                open={inviteDialogOpen}
                onOpenChange={(open) => {
                  setInviteDialogOpen(open);
                  if (!open) {
                    setGeneratedLink("");
                    setInviteEmail("");
                    setInviteRole("member");
                    setInviteExpiry("7");
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button size="sm">Invite User</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create Invitation</DialogTitle>
                  </DialogHeader>
                  {!generatedLink ? (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label>Role</Label>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant={
                              inviteRole === "member" ? "default" : "outline"
                            }
                            onClick={() => setInviteRole("member")}
                          >
                            Member
                          </Button>
                          <Button
                            size="sm"
                            variant={
                              inviteRole === "admin" ? "default" : "outline"
                            }
                            onClick={() => setInviteRole("admin")}
                          >
                            Admin
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="invite-email">
                          Email (optional — restricts who can accept)
                        </Label>
                        <Input
                          id="invite-email"
                          type="email"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          placeholder="user@example.com"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="invite-expiry">Expires in (days)</Label>
                        <Input
                          id="invite-expiry"
                          type="number"
                          min="1"
                          max="30"
                          value={inviteExpiry}
                          onChange={(e) => setInviteExpiry(e.target.value)}
                        />
                      </div>
                      <Button
                        className="w-full"
                        onClick={handleCreateInvite}
                        disabled={inviteLoading}
                      >
                        {inviteLoading ? "Creating..." : "Create Invite"}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <p className="text-sm text-neutral-600">
                        Share this link with the user:
                      </p>
                      <div className="flex gap-2">
                        <Input value={generatedLink} readOnly />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleCopy}
                        >
                          {copied ? "Copied!" : "Copy"}
                        </Button>
                      </div>
                    </div>
                  )}
                </DialogContent>
              </Dialog>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-neutral-500">Loading...</p>
              ) : (
                <div className="divide-y">
                  {users.map((user) => (
                    <div
                      key={user.id}
                      className="flex items-center justify-between py-3"
                    >
                      <div>
                        <p className="font-medium">{user.name}</p>
                        <p className="text-sm text-neutral-500">{user.email}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={user.hasPasskey ? "default" : "secondary"}
                        >
                          {user.hasPasskey ? "Passkey" : "No passkey"}
                        </Badge>
                        <Badge
                          variant={
                            user.role === "admin" ? "default" : "outline"
                          }
                        >
                          {user.role || "member"}
                        </Badge>
                        <span className="text-xs text-neutral-400">
                          {formatDate(user.createdAt)}
                        </span>
                        {user.id !== session?.user?.id && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm">
                                ...
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() =>
                                  handleRoleChange(
                                    user.id,
                                    user.role === "admin" ? "member" : "admin",
                                  )
                                }
                              >
                                Make{" "}
                                {user.role === "admin" ? "member" : "admin"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleDelete(user.id)}
                                className="text-red-600"
                              >
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Invitations Section */}
          <Card>
            <CardHeader>
              <CardTitle>Invitations</CardTitle>
            </CardHeader>
            <CardContent>
              {invites.length === 0 ? (
                <p className="text-sm text-neutral-500">No invitations yet.</p>
              ) : (
                <div className="divide-y">
                  {invites.map((invite) => {
                    const st = inviteStatus(invite);
                    return (
                      <div
                        key={invite.id}
                        className="flex items-center justify-between py-3"
                      >
                        <div>
                          <p className="text-sm font-medium">
                            {invite.email || "Any email"}
                          </p>
                          <p className="text-xs text-neutral-500">
                            Role: {invite.role} | Expires:{" "}
                            {formatDate(invite.expiresAt)}
                          </p>
                        </div>
                        <Badge
                          variant={
                            st === "used"
                              ? "default"
                              : st === "expired"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {st}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/AdminUsersPage.tsx
git commit -m "feat: add AdminUsersPage with user management and invite UI"
```

---

### Task 13: Update LoginPage to passkey-only login

**Files:**

- Modify: `src/pages/LoginPage.tsx`

- [ ] **Step 1: Replace LoginPage with passkey-only login**

Replace the full contents of `src/pages/LoginPage.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup/status");
        const data = (await res.json()) as { setupRequired: boolean };
        if (!cancelled) setSetupRequired(data.setupRequired);
      } catch {
        if (!cancelled) setSetupRequired(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (setupRequired === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  if (setupRequired) {
    return <Navigate to="/onboarding" replace />;
  }

  async function handlePasskeyLogin() {
    setLoading(true);
    setError("");
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        setError(result.error.message || "Passkey sign-in failed");
      } else {
        window.location.href = "/";
      }
    } catch {
      setError("Passkey sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">cmail</CardTitle>
          <p className="text-sm text-neutral-500">
            Sign in with your passkey to continue.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button
            className="w-full"
            onClick={handlePasskeyLogin}
            disabled={loading}
          >
            {loading ? "Signing in..." : "Sign in with Passkey"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/LoginPage.tsx
git commit -m "feat: replace email/password login with passkey-only login"
```

---

### Task 14: Update OnboardingPage to redirect to passkey setup

**Files:**

- Modify: `src/pages/OnboardingPage.tsx`

- [ ] **Step 1: Change the redirect after onboarding**

In `src/pages/OnboardingPage.tsx`, change the success redirect from `window.location.href = "/"` to `window.location.href = "/setup-passkey"` (line 59).

Find:

```typescript
window.location.href = "/";
```

Replace with:

```typescript
window.location.href = "/setup-passkey";
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/OnboardingPage.tsx
git commit -m "feat: redirect onboarding to passkey setup instead of inbox"
```

---

### Task 15: Update App.tsx routes and AuthGuard with passkey check

**Files:**

- Modify: `src/App.tsx`

- [ ] **Step 1: Replace App.tsx with updated routes and passkey-aware AuthGuard**

Replace the full contents of `src/App.tsx` with:

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { fetchPasskeyStatus } from "@/lib/api";
import { useEffect, useState } from "react";
import LoginPage from "@/pages/LoginPage";
import OnboardingPage from "@/pages/OnboardingPage";
import InboxPage from "@/pages/InboxPage";
import TemplatesPage from "@/pages/TemplatesPage";
import TemplateEditorPage from "@/pages/TemplateEditorPage";
import SetupPasskeyPage from "@/pages/SetupPasskeyPage";
import InviteAcceptPage from "@/pages/InviteAcceptPage";
import AdminUsersPage from "@/pages/AdminUsersPage";

const queryClient = new QueryClient();

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const [passkeyStatus, setPasskeyStatus] = useState<boolean | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchPasskeyStatus()
      .then((res) => {
        if (!cancelled) setPasskeyStatus(res.hasPasskey);
      })
      .catch(() => {
        if (!cancelled) setPasskeyStatus(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (passkeyStatus === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  if (!passkeyStatus) {
    return <Navigate to="/setup-passkey" replace />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
          <Route path="/setup-passkey" element={<SetupPasskeyPage />} />
          <Route
            path="/admin/users"
            element={
              <AuthGuard>
                <AdminUsersPage />
              </AuthGuard>
            }
          />
          <Route
            path="/templates"
            element={
              <AuthGuard>
                <TemplatesPage />
              </AuthGuard>
            }
          />
          <Route
            path="/templates/new"
            element={
              <AuthGuard>
                <TemplateEditorPage />
              </AuthGuard>
            }
          />
          <Route
            path="/templates/:slug/edit"
            element={
              <AuthGuard>
                <TemplateEditorPage />
              </AuthGuard>
            }
          />
          <Route
            path="/*"
            element={
              <AuthGuard>
                <InboxPage />
              </AuthGuard>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
```

Key changes:

- `AuthGuard` now checks passkey status — if no passkey, redirects to `/setup-passkey`
- New routes: `/invite/:token`, `/setup-passkey`, `/admin/users`
- Added imports for new pages

- [ ] **Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "feat: update routes and AuthGuard with passkey enforcement"
```

---

### Task 16: Add "Users" nav link for admins in InboxPage

**Files:**

- Modify: `src/pages/InboxPage.tsx`

- [ ] **Step 1: Add Users link to the header, visible only to admins**

In `src/pages/InboxPage.tsx`, add a "Users" link right before the "Templates" link. Find:

```tsx
<Link
  to="/templates"
  className="text-sm text-neutral-500 hover:text-neutral-700"
>
  Templates
</Link>
```

Replace with:

```tsx
{
  session?.user?.role === "admin" && (
    <Link
      to="/admin/users"
      className="text-sm text-neutral-500 hover:text-neutral-700"
    >
      Users
    </Link>
  );
}
<Link
  to="/templates"
  className="text-sm text-neutral-500 hover:text-neutral-700"
>
  Templates
</Link>;
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/InboxPage.tsx
git commit -m "feat: add Users nav link for admins in inbox header"
```

---

### Task 17: Install shadcn dialog component (if missing)

**Files:**

- Possibly modify: `src/components/ui/dialog.tsx`

- [ ] **Step 1: Check if Dialog component exists**

Run:

```bash
ls src/components/ui/dialog.tsx 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

- [ ] **Step 2: If MISSING, add the Dialog component**

Run:

```bash
npx shadcn@latest add dialog
```

If it already exists, skip this task.

- [ ] **Step 3: Commit (if changes were made)**

```bash
git add src/components/ui/dialog.tsx
git commit -m "chore: add shadcn dialog component"
```

---

### Task 18: Build and verify

**Files:** None (verification only)

- [ ] **Step 1: Type-check the backend**

Run:

```bash
npx tsc --noEmit --project worker/tsconfig.json
```

Expected: No errors

- [ ] **Step 2: Type-check the frontend**

Run:

```bash
npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Build the frontend**

Run:

```bash
npm run build
```

Expected: Successful build

- [ ] **Step 4: Start the dev server and verify routes load**

Run:

```bash
npm run dev
```

Manually verify:

1. `/login` shows passkey-only sign-in button
2. `/onboarding` still shows admin setup form (if no users exist)
3. `/invite/fake-token` shows "Invalid Invitation" message
4. `/setup-passkey` shows passkey registration prompt

- [ ] **Step 5: Apply migrations to remote (when ready to deploy)**

Run:

```bash
npx wrangler d1 migrations apply cmail-db --remote
```
