# cmail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a sender-centric email client for teams on Cloudflare Workers with D1, R2, Hono, BetterAuth, and a React+Vite frontend.

**Architecture:** Single-repo full-stack app following aventuresim patterns. Worker exports both `fetch` (Hono API + static assets) and `email` (Cloudflare Email Worker) handlers. React SPA served via Cloudflare static assets binding.

**Tech Stack:** Cloudflare Workers, Hono + Zod OpenAPI, Drizzle ORM + D1, R2, BetterAuth (invite-only), Resend, React 18, Vite, Tailwind CSS, shadcn/ui, postal-mime, nanoid.

---

## File Structure

```
cmail/
├── .gitignore
├── .dev.vars.example
├── wrangler.jsonc.example
├── package.json
├── tsconfig.json
├── tsconfig.app.json
├── vite.config.ts
├── drizzle.config.ts
├── components.json                # shadcn/ui config
├── tailwind.config.ts
├── postcss.config.js
├── migrations/                    # Drizzle-generated
├── worker/
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts               # Hono app entry + email export
│       ├── variables.ts           # Context variable types
│       ├── email-handler.ts       # Email Worker handler
│       ├── auth/
│       │   └── index.ts           # BetterAuth config
│       ├── db/
│       │   ├── index.ts           # Re-exports all schemas
│       │   ├── schema.ts          # Combined schema object
│       │   ├── auth.schema.ts     # BetterAuth generated
│       │   ├── senders.schema.ts
│       │   ├── emails.schema.ts
│       │   ├── sent-emails.schema.ts
│       │   ├── attachments.schema.ts
│       │   └── middleware.ts      # DB injection middleware
│       ├── routers/
│       │   ├── senders-router.ts
│       │   ├── emails-router.ts
│       │   ├── send-router.ts
│       │   ├── attachments-router.ts
│       │   └── stats-router.ts
│       └── lib/
│           ├── helpers.ts         # json200Response, error helpers
│           └── email-parser.ts    # MIME parsing wrapper
├── src/
│   ├── main.tsx
│   ├── index.css                  # Tailwind imports
│   ├── App.tsx                    # Router setup
│   ├── lib/
│   │   ├── api.ts                 # API client functions
│   │   ├── auth-client.ts         # BetterAuth React client
│   │   └── utils.ts               # cn() helper for shadcn
│   ├── components/
│   │   └── ui/                    # shadcn/ui components (auto-generated)
│   └── pages/
│       ├── LoginPage.tsx
│       ├── InboxPage.tsx          # Main two-panel layout
│       ├── SenderList.tsx         # Left panel component
│       ├── SenderDetail.tsx       # Right panel component
│       └── ComposeModal.tsx       # Compose/reply modal
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.app.json`
- Create: `worker/tsconfig.json`
- Create: `.gitignore`
- Create: `wrangler.jsonc.example`
- Create: `.dev.vars.example`
- Create: `vite.config.ts`
- Create: `drizzle.config.ts`
- Create: `postcss.config.js`
- Create: `tailwind.config.ts`
- Create: `components.json`
- Create: `src/lib/utils.ts`
- Create: `src/index.css`
- Create: `src/main.tsx`
- Create: `src/App.tsx`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "cmail",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "deploy": "vite build && wrangler deploy --minify",
    "auth:generate": "npx @better-auth/cli@latest generate --config worker/src/auth/index.ts --output worker/src/db/auth.schema.ts -y",
    "auth:migrate": "npx @better-auth/cli@latest migrate --config worker/src/auth/index.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate:dev": "wrangler d1 migrations apply cmail-db --local",
    "db:migrate:prod": "wrangler d1 migrations apply cmail-db --remote",
    "db:studio:dev": "drizzle-kit studio",
    "db:studio:prod": "NODE_ENV=production drizzle-kit studio"
  },
  "dependencies": {
    "@hono/swagger-ui": "^0.5.2",
    "@hono/zod-openapi": "^1.1.0",
    "@tanstack/react-query": "^5.83.0",
    "better-auth": "^1.4.19",
    "drizzle-orm": "^0.44.5",
    "hono": "^4.9.6",
    "nanoid": "^5.1.5",
    "postal-mime": "^2.4.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.30.1",
    "resend": "^6.9.2",
    "zod": "^3.24.4"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^1.0.0",
    "@cloudflare/workers-types": "^4.20250410.0",
    "@tailwindcss/vite": "^4.1.0",
    "@types/react": "^18.3.20",
    "@types/react-dom": "^18.3.6",
    "@vitejs/plugin-react-swc": "^3.9.0",
    "autoprefixer": "^10.4.21",
    "drizzle-kit": "^0.31.1",
    "postcss": "^8.5.3",
    "tailwindcss": "^4.1.0",
    "typescript": "^5.8.3",
    "vite": "^7.0.0",
    "wrangler": "^4.14.0"
  }
}
```

- [ ] **Step 2: Create TypeScript configs**

`tsconfig.json`:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" }
  ],
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "noImplicitAny": false,
    "skipLibCheck": true,
    "allowJs": true
  }
}
```

`tsconfig.app.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "strict": false,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`worker/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",
    "types": ["@cloudflare/workers-types"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "worker-configuration.d.ts"]
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
.wrangler/
.dev.vars
wrangler.jsonc
.DS_Store
*.log
```

- [ ] **Step 4: Create wrangler.jsonc.example and .dev.vars.example**

`wrangler.jsonc.example`:
```jsonc
{
  // Copy this file to wrangler.jsonc and fill in your values.
  // wrangler.jsonc is gitignored so each deployer has their own config.
  "name": "cmail",
  "main": "worker/src/index.ts",
  "compatibility_date": "2026-04-14",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "cmail-db",
      "database_id": "<your-database-id>"
    }
  ],
  "r2_buckets": [
    {
      "binding": "R2",
      "bucket_name": "cmail-attachments"
    }
  ],
  "assets": {
    "directory": "./dist/client",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },
  "email_routing": {
    "enabled": true
  },
  "observability": {
    "enabled": true
  }
}
```

`.dev.vars.example`:
```
RESEND_API_KEY=re_xxxx
RESEND_EMAIL_FROM=noreply@yourdomain.com
BETTER_AUTH_SECRET=generate-a-random-secret
```

- [ ] **Step 5: Create vite.config.ts**

```typescript
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [cloudflare(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

- [ ] **Step 6: Create drizzle.config.ts**

```typescript
import { defineConfig } from "drizzle-kit";
import fs from "fs";
import path from "path";

function getLocalD1DB(): string {
  const wranglerDir = path.resolve(".wrangler");
  const d1Dir = path.join(wranglerDir, "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!fs.existsSync(d1Dir)) {
    throw new Error(`D1 directory not found at ${d1Dir}. Run 'wrangler dev' first.`);
  }
  const files = fs.readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (files.length === 0) {
    throw new Error("No SQLite files found. Run 'wrangler dev' first.");
  }
  return path.join(d1Dir, files[0]);
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./worker/src/db/index.ts",
  out: "./migrations",
  ...(process.env.NODE_ENV === "production"
    ? {
        driver: "d1-http",
        dbCredentials: {
          accountId: process.env.CLOUDFLARE_D1_ACCOUNT_ID!,
          databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
          token: process.env.CLOUDFLARE_D1_API_TOKEN!,
        },
      }
    : {
        dbCredentials: {
          url: getLocalD1DB(),
        },
      }),
});
```

- [ ] **Step 7: Create postcss.config.js and tailwind.config.ts**

`postcss.config.js`:
```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

`tailwind.config.ts`:
```typescript
import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 8: Create shadcn components.json**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui"
  }
}
```

- [ ] **Step 9: Create src/lib/utils.ts**

```typescript
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Note: Also install clsx and tailwind-merge: add `"clsx": "^2.1.1"` and `"tailwind-merge": "^3.0.2"` to dependencies in package.json.

- [ ] **Step 10: Create src/index.css**

```css
@import "tailwindcss";
```

- [ ] **Step 11: Create src/main.tsx**

```typescript
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 12: Create src/App.tsx (minimal placeholder)**

```tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<div>cmail</div>} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
```

- [ ] **Step 13: Create index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>cmail</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 14: Install dependencies and verify build**

Run: `yarn install`
Expected: Successful install with no errors.

Run: `yarn build`
Expected: Vite builds successfully (may warn about missing worker entry — that's fine for now).

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat: project scaffolding with Vite, Tailwind, Hono, Drizzle config"
```

---

## Task 2: Database Schemas

**Files:**
- Create: `worker/src/db/senders.schema.ts`
- Create: `worker/src/db/emails.schema.ts`
- Create: `worker/src/db/sent-emails.schema.ts`
- Create: `worker/src/db/attachments.schema.ts`
- Create: `worker/src/db/schema.ts`
- Create: `worker/src/db/index.ts`
- Create: `worker/src/db/middleware.ts`

- [ ] **Step 1: Create senders schema**

`worker/src/db/senders.schema.ts`:
```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const senders = sqliteTable("senders", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  lastEmailAt: integer("last_email_at").notNull(),
  unreadCount: integer("unread_count").notNull().default(0),
  totalCount: integer("total_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

- [ ] **Step 2: Create emails schema**

`worker/src/db/emails.schema.ts`:
```typescript
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const emails = sqliteTable(
  "emails",
  {
    id: text("id").primaryKey(),
    senderId: text("sender_id").notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    rawHeaders: text("raw_headers"),
    messageId: text("message_id").unique(),
    isRead: integer("is_read").notNull().default(0),
    receivedAt: integer("received_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("emails_sender_received_idx").on(table.senderId, table.receivedAt),
    index("emails_recipient_received_idx").on(table.recipient, table.receivedAt),
  ]
);
```

- [ ] **Step 3: Create sent_emails schema**

`worker/src/db/sent-emails.schema.ts`:
```typescript
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const sentEmails = sqliteTable(
  "sent_emails",
  {
    id: text("id").primaryKey(),
    senderId: text("sender_id"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    inReplyTo: text("in_reply_to"),
    resendId: text("resend_id"),
    status: text("status").notNull().default("sent"),
    sentAt: integer("sent_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("sent_emails_sender_sent_idx").on(table.senderId, table.sentAt),
  ]
);
```

- [ ] **Step 4: Create attachments schema**

`worker/src/db/attachments.schema.ts`:
```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  emailId: text("email_id").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  r2Key: text("r2_key").notNull(),
  createdAt: integer("created_at").notNull(),
});
```

- [ ] **Step 5: Create schema.ts and index.ts**

`worker/src/db/schema.ts`:
```typescript
import { senders } from "./senders.schema";
import { emails } from "./emails.schema";
import { sentEmails } from "./sent-emails.schema";
import { attachments } from "./attachments.schema";

export const schema = {
  senders,
  emails,
  sentEmails,
  attachments,
} as const;
```

`worker/src/db/index.ts`:
```typescript
export * from "drizzle-orm";
export * from "./senders.schema";
export * from "./emails.schema";
export * from "./sent-emails.schema";
export * from "./attachments.schema";
export * from "./schema";
```

- [ ] **Step 6: Create DB middleware**

`worker/src/db/middleware.ts`:
```typescript
import { drizzle } from "drizzle-orm/d1";
import type { Context, Next } from "hono";
import { schema } from "./schema";

export async function injectDb(c: Context, next: Next) {
  const db = drizzle(c.env.DB, { schema, logger: true });
  c.set("db", db);
  return await next();
}
```

- [ ] **Step 7: Generate initial migration**

Run: `yarn db:generate`
Expected: Migration SQL files created in `migrations/` directory.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: database schemas for senders, emails, sent_emails, attachments"
```

---

## Task 3: BetterAuth Setup

**Files:**
- Create: `worker/src/auth/index.ts`
- Create: `worker/src/db/auth.schema.ts`
- Create: `src/lib/auth-client.ts`

- [ ] **Step 1: Create BetterAuth server config**

`worker/src/auth/index.ts`:
```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, openAPI, invitation } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { Resend } from "resend";

export function createAuth(env?: CloudflareBindings) {
  const db = env ? drizzle(env.DB, { schema, logger: true }) : ({} as any);
  const resend = env ? new Resend(env.RESEND_API_KEY) : null;
  const fromEmail = env?.RESEND_EMAIL_FROM!;

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
    }),
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      admin(),
      openAPI(),
      invitation({
        sendInvitationEmail: async ({ email, invitedBy, url }) => {
          if (!resend) return;
          await resend.emails.send({
            from: fromEmail,
            to: email,
            subject: `You've been invited to cmail`,
            html: `<p>${invitedBy.name || invitedBy.email} invited you to cmail.</p><p><a href="${url}">Accept invitation</a></p>`,
          });
        },
      }),
    ],
    advanced: {
      cookiePrefix: "cmail",
      defaultCookieAttributes: { sameSite: "lax", secure: true },
    },
    trustedOrigins: [
      "http://localhost:8080",
    ],
  });
}

export const auth = createAuth();
```

- [ ] **Step 2: Generate BetterAuth schema**

Run: `yarn auth:generate`
Expected: `worker/src/db/auth.schema.ts` is created with users, sessions, accounts, verifications, and invitations tables.

- [ ] **Step 3: Update schema.ts to include auth schema**

Update `worker/src/db/schema.ts`:
```typescript
import * as authSchema from "./auth.schema";
import { senders } from "./senders.schema";
import { emails } from "./emails.schema";
import { sentEmails } from "./sent-emails.schema";
import { attachments } from "./attachments.schema";

export const schema = {
  ...authSchema,
  senders,
  emails,
  sentEmails,
  attachments,
} as const;
```

Update `worker/src/db/index.ts` to add:
```typescript
export * from "./auth.schema";
```

- [ ] **Step 4: Create BetterAuth React client**

`src/lib/auth-client.ts`:
```typescript
import { createAuthClient } from "better-auth/react";
import { adminClient, invitationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [adminClient(), invitationClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
```

- [ ] **Step 5: Regenerate migration to include auth tables**

Run: `yarn db:generate`
Expected: New migration file that includes BetterAuth tables.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: BetterAuth with invite-only access and email/password auth"
```

---

## Task 4: Worker Entry Point & Middleware

**Files:**
- Create: `worker/src/variables.ts`
- Create: `worker/src/lib/helpers.ts`
- Create: `worker/src/index.ts`

- [ ] **Step 1: Create variables type**

`worker/src/variables.ts`:
```typescript
import type { DrizzleD1Database } from "drizzle-orm/d1";

export type Variables = {
  user?: any;
  db: DrizzleD1Database<any>;
};
```

- [ ] **Step 2: Create API helpers**

`worker/src/lib/helpers.ts`:
```typescript
import { z } from "zod";

export function json200Response(schema: z.ZodType, description: string) {
  return {
    200: {
      description,
      content: {
        "application/json": {
          schema,
        },
      },
    },
  };
}

export function json201Response(schema: z.ZodType, description: string) {
  return {
    201: {
      description,
      content: {
        "application/json": {
          schema,
        },
      },
    },
  };
}
```

- [ ] **Step 3: Create worker entry point**

`worker/src/index.ts`:
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
import type { Variables } from "./variables";

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
    origin: ["http://localhost:8080"],
    credentials: true,
  })
);

// BetterAuth handler
app.all("/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// Session resolution for all API routes
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth")) {
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

// API Routes
app.route("/api/senders", sendersRouter);
app.route("/api/emails", emailsRouter);
app.route("/api/send", sendRouter);
app.route("/api/attachments", attachmentsRouter);
app.route("/api/stats", statsRouter);

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

- [ ] **Step 4: Create placeholder email handler**

`worker/src/email-handler.ts`:
```typescript
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: CloudflareBindings,
  ctx: ExecutionContext
): Promise<void> {
  // Will be implemented in Task 5
  console.log(`Received email from ${message.from} to ${message.to}`);
}
```

- [ ] **Step 5: Create placeholder routers**

Create empty routers so the entry point compiles. Each file follows this pattern:

`worker/src/routers/senders-router.ts`:
```typescript
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Variables } from "../variables";

export const sendersRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();
```

Repeat for `emails-router.ts`, `send-router.ts`, `attachments-router.ts`, `stats-router.ts` (changing the export name accordingly: `emailsRouter`, `sendRouter`, `attachmentsRouter`, `statsRouter`).

- [ ] **Step 6: Verify compilation**

Create a local `wrangler.jsonc` from the example (for local dev only, won't be committed):

Run: `cp wrangler.jsonc.example wrangler.jsonc`

Then verify types:

Run: `npx tsc --noEmit -p worker/tsconfig.json`
Expected: No type errors (or only minor ones from missing worker-configuration.d.ts which wrangler generates).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: Hono worker entry point with auth, middleware, and route skeleton"
```

---

## Task 5: Email Worker Handler

**Files:**
- Create: `worker/src/lib/email-parser.ts`
- Modify: `worker/src/email-handler.ts`

- [ ] **Step 1: Create email parser wrapper**

`worker/src/lib/email-parser.ts`:
```typescript
import PostalMime from "postal-mime";

export interface ParsedEmail {
  from: { address: string; name: string };
  to: string;
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  messageId: string | null;
  headers: Record<string, string>;
  attachments: ParsedAttachment[];
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
}

export async function parseEmail(
  message: ForwardableEmailMessage
): Promise<ParsedEmail> {
  const rawEmail = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmail);

  const headers: Record<string, string> = {};
  if (parsed.headers) {
    for (const header of parsed.headers) {
      headers[header.key] = header.value;
    }
  }

  return {
    from: {
      address: message.from,
      name: parsed.from?.name || "",
    },
    to: message.to,
    subject: parsed.subject || "",
    bodyHtml: parsed.html || null,
    bodyText: parsed.text || null,
    messageId: parsed.messageId || null,
    headers,
    attachments: (parsed.attachments || []).map((att) => ({
      filename: att.filename || "unnamed",
      contentType: att.mimeType || "application/octet-stream",
      content: att.content,
    })),
  };
}
```

- [ ] **Step 2: Implement email handler**

`worker/src/email-handler.ts`:
```typescript
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schema } from "./db/schema";
import { senders } from "./db/senders.schema";
import { emails } from "./db/emails.schema";
import { attachments } from "./db/attachments.schema";
import { parseEmail } from "./lib/email-parser";

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: CloudflareBindings,
  ctx: ExecutionContext
): Promise<void> {
  const db = drizzle(env.DB, { schema, logger: true });
  const parsed = await parseEmail(message);
  const now = Math.floor(Date.now() / 1000);

  // Deduplicate by Message-ID
  if (parsed.messageId) {
    const existing = await db
      .select({ id: emails.id })
      .from(emails)
      .where(eq(emails.messageId, parsed.messageId))
      .limit(1);
    if (existing.length > 0) {
      console.log(`Duplicate email with Message-ID: ${parsed.messageId}`);
      return;
    }
  }

  // Upsert sender
  const existingSender = await db
    .select()
    .from(senders)
    .where(eq(senders.email, parsed.from.address))
    .limit(1);

  let senderId: string;

  if (existingSender.length > 0) {
    senderId = existingSender[0].id;
    await db
      .update(senders)
      .set({
        name: parsed.from.name || existingSender[0].name,
        lastEmailAt: now,
        unreadCount: existingSender[0].unreadCount + 1,
        totalCount: existingSender[0].totalCount + 1,
        updatedAt: now,
      })
      .where(eq(senders.id, senderId));
  } else {
    senderId = nanoid();
    await db.insert(senders).values({
      id: senderId,
      email: parsed.from.address,
      name: parsed.from.name || null,
      lastEmailAt: now,
      unreadCount: 1,
      totalCount: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Insert email
  const emailId = nanoid();
  await db.insert(emails).values({
    id: emailId,
    senderId,
    recipient: parsed.to,
    subject: parsed.subject,
    bodyHtml: parsed.bodyHtml,
    bodyText: parsed.bodyText,
    rawHeaders: JSON.stringify(parsed.headers),
    messageId: parsed.messageId,
    isRead: 0,
    receivedAt: now,
    createdAt: now,
  });

  // Process attachments
  for (const att of parsed.attachments) {
    const attachmentId = nanoid();
    const r2Key = `attachments/${emailId}/${att.filename}`;

    await env.R2.put(r2Key, att.content, {
      httpMetadata: { contentType: att.contentType },
    });

    await db.insert(attachments).values({
      id: attachmentId,
      emailId,
      filename: att.filename,
      contentType: att.contentType,
      size: att.content.byteLength,
      r2Key,
      createdAt: now,
    });
  }

  console.log(`Processed email from ${parsed.from.address} to ${parsed.to} (${parsed.attachments.length} attachments)`);
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: email worker handler with MIME parsing, sender upsert, R2 attachments"
```

---

## Task 6: Senders API Router

**Files:**
- Modify: `worker/src/routers/senders-router.ts`

- [ ] **Step 1: Implement senders router**

`worker/src/routers/senders-router.ts`:
```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, like, or, eq, sql } from "drizzle-orm";
import { senders } from "../db/senders.schema";
import { emails } from "../db/emails.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const sendersRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const SenderSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  lastEmailAt: z.number(),
  unreadCount: z.number(),
  totalCount: z.number(),
  latestSubject: z.string().nullable().optional(),
});

const listSendersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Senders"],
  description: "List senders sorted by most recent email.",
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: "Search sender name/email" }),
      recipient: z.string().optional().openapi({ description: "Filter by recipient address" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
  },
  responses: {
    ...json200Response(z.array(SenderSchema), "List of senders"),
  },
});

sendersRouter.openapi(listSendersRoute, async (c) => {
  const db = c.get("db");
  const { q, recipient, page, limit } = c.req.valid("query");
  const offset = (page - 1) * limit;

  const conditions: any[] = [];

  if (q) {
    const pattern = `%${q}%`;
    conditions.push(
      or(like(senders.email, pattern), like(senders.name, pattern))
    );
  }

  if (recipient) {
    // Filter senders who have emails to this recipient
    conditions.push(
      sql`${senders.id} IN (
        SELECT DISTINCT ${emails.senderId} FROM ${emails}
        WHERE ${emails.recipient} = ${recipient}
      )`
    );
  }

  const where = conditions.length > 0
    ? sql`${sql.join(conditions, sql` AND `)}`
    : undefined;

  const rows = await db
    .select({
      id: senders.id,
      email: senders.email,
      name: senders.name,
      lastEmailAt: senders.lastEmailAt,
      unreadCount: senders.unreadCount,
      totalCount: senders.totalCount,
    })
    .from(senders)
    .where(where)
    .orderBy(desc(senders.lastEmailAt))
    .limit(limit)
    .offset(offset);

  // Get latest subject for each sender
  const result = await Promise.all(
    rows.map(async (sender) => {
      const latest = await db
        .select({ subject: emails.subject })
        .from(emails)
        .where(eq(emails.senderId, sender.id))
        .orderBy(desc(emails.receivedAt))
        .limit(1);
      return {
        ...sender,
        latestSubject: latest[0]?.subject ?? null,
      };
    })
  );

  return c.json(result, 200);
});

const getSenderRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Senders"],
  description: "Get sender detail.",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    ...json200Response(SenderSchema, "Sender detail"),
  },
});

sendersRouter.openapi(getSenderRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const rows = await db
    .select()
    .from(senders)
    .where(eq(senders.id, id))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Sender not found" }, 404);
  }

  return c.json(rows[0], 200);
});
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: senders API with list, search, recipient filter, and detail"
```

---

## Task 7: Emails API Router

**Files:**
- Modify: `worker/src/routers/emails-router.ts`

- [ ] **Step 1: Implement emails router**

`worker/src/routers/emails-router.ts`:
```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, desc, like, and, sql } from "drizzle-orm";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { attachments } from "../db/attachments.schema";
import { senders } from "../db/senders.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const emailsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const EmailSchema = z.object({
  id: z.string(),
  type: z.enum(["received", "sent"]),
  senderId: z.string().nullable(),
  recipient: z.string().nullable(),
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  subject: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  isRead: z.number().nullable(),
  timestamp: z.number(),
  attachmentCount: z.number().optional(),
});

// List emails for a sender (received + sent interleaved)
const listSenderEmailsRoute = createRoute({
  method: "get",
  path: "/by-sender/{senderId}",
  tags: ["Emails"],
  description: "List all emails for a sender (received and sent, interleaved chronologically).",
  request: {
    params: z.object({ senderId: z.string() }),
    query: z.object({
      q: z.string().optional().openapi({ description: "Search by subject" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
  },
  responses: {
    ...json200Response(z.array(EmailSchema), "Emails for sender"),
  },
});

emailsRouter.openapi(listSenderEmailsRoute, async (c) => {
  const db = c.get("db");
  const { senderId } = c.req.valid("param");
  const { q, page, limit } = c.req.valid("query");
  const offset = (page - 1) * limit;

  // Build conditions for received emails
  const receivedConditions: any[] = [eq(emails.senderId, senderId)];
  if (q) {
    receivedConditions.push(like(emails.subject, `%${q}%`));
  }

  const received = await db
    .select({
      id: emails.id,
      subject: emails.subject,
      bodyHtml: emails.bodyHtml,
      bodyText: emails.bodyText,
      isRead: emails.isRead,
      timestamp: emails.receivedAt,
      recipient: emails.recipient,
    })
    .from(emails)
    .where(and(...receivedConditions))
    .orderBy(desc(emails.receivedAt));

  // Build conditions for sent emails
  const sentConditions: any[] = [eq(sentEmails.senderId, senderId)];
  if (q) {
    sentConditions.push(like(sentEmails.subject, `%${q}%`));
  }

  const sent = await db
    .select({
      id: sentEmails.id,
      subject: sentEmails.subject,
      bodyHtml: sentEmails.bodyHtml,
      bodyText: sentEmails.bodyText,
      timestamp: sentEmails.sentAt,
      fromAddress: sentEmails.fromAddress,
      toAddress: sentEmails.toAddress,
    })
    .from(sentEmails)
    .where(and(...sentConditions))
    .orderBy(desc(sentEmails.sentAt));

  // Merge and sort
  const merged = [
    ...received.map((e) => ({
      id: e.id,
      type: "received" as const,
      senderId,
      recipient: e.recipient,
      fromAddress: null,
      toAddress: null,
      subject: e.subject,
      bodyHtml: e.bodyHtml,
      bodyText: e.bodyText,
      isRead: e.isRead,
      timestamp: e.timestamp,
    })),
    ...sent.map((e) => ({
      id: e.id,
      type: "sent" as const,
      senderId,
      recipient: null,
      fromAddress: e.fromAddress,
      toAddress: e.toAddress,
      subject: e.subject,
      bodyHtml: e.bodyHtml,
      bodyText: e.bodyText,
      isRead: null,
      timestamp: e.timestamp,
    })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  const paginated = merged.slice(offset, offset + limit);

  // Get attachment counts for received emails
  const receivedIds = paginated
    .filter((e) => e.type === "received")
    .map((e) => e.id);

  let attachmentCounts: Record<string, number> = {};
  if (receivedIds.length > 0) {
    const counts = await db
      .select({
        emailId: attachments.emailId,
        count: sql<number>`COUNT(*)`,
      })
      .from(attachments)
      .where(sql`${attachments.emailId} IN (${sql.join(receivedIds.map(id => sql`${id}`), sql`,`)})`)
      .groupBy(attachments.emailId);

    for (const row of counts) {
      attachmentCounts[row.emailId] = row.count;
    }
  }

  const result = paginated.map((e) => ({
    ...e,
    attachmentCount: attachmentCounts[e.id] ?? 0,
  }));

  return c.json(result, 200);
});

// Get single email detail
const getEmailRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Emails"],
  description: "Get a single email with full details.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(EmailSchema, "Email detail"),
  },
});

emailsRouter.openapi(getEmailRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const row = await db
    .select()
    .from(emails)
    .where(eq(emails.id, id))
    .limit(1);

  if (row.length === 0) {
    return c.json({ error: "Email not found" }, 404);
  }

  const atts = await db
    .select()
    .from(attachments)
    .where(eq(attachments.emailId, id));

  return c.json({
    ...row[0],
    type: "received",
    timestamp: row[0].receivedAt,
    fromAddress: null,
    toAddress: null,
    attachments: atts,
  }, 200);
});

// Mark email read/unread
const patchEmailRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Emails"],
  description: "Mark an email as read or unread.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            isRead: z.boolean(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Updated"),
  },
});

emailsRouter.openapi(patchEmailRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const { isRead } = c.req.valid("json");

  const email = await db
    .select({ senderId: emails.senderId, isRead: emails.isRead })
    .from(emails)
    .where(eq(emails.id, id))
    .limit(1);

  if (email.length === 0) {
    return c.json({ error: "Email not found" }, 404);
  }

  const wasRead = email[0].isRead === 1;
  const nowRead = isRead;

  if (wasRead !== nowRead) {
    await db
      .update(emails)
      .set({ isRead: nowRead ? 1 : 0 })
      .where(eq(emails.id, id));

    // Update sender unread count
    const delta = nowRead ? -1 : 1;
    await db
      .update(senders)
      .set({
        unreadCount: sql`${senders.unreadCount} + ${delta}`,
      })
      .where(eq(senders.id, email[0].senderId));
  }

  return c.json({ success: true }, 200);
});

// Bulk mark read/unread
const bulkPatchRoute = createRoute({
  method: "patch",
  path: "/bulk",
  tags: ["Emails"],
  description: "Bulk mark emails as read or unread.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            ids: z.array(z.string()),
            isRead: z.boolean(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Updated"),
  },
});

emailsRouter.openapi(bulkPatchRoute, async (c) => {
  const db = c.get("db");
  const { ids, isRead } = c.req.valid("json");

  for (const id of ids) {
    const email = await db
      .select({ senderId: emails.senderId, isRead: emails.isRead })
      .from(emails)
      .where(eq(emails.id, id))
      .limit(1);

    if (email.length === 0) continue;

    const wasRead = email[0].isRead === 1;
    if (wasRead !== isRead) {
      await db
        .update(emails)
        .set({ isRead: isRead ? 1 : 0 })
        .where(eq(emails.id, id));

      const delta = isRead ? -1 : 1;
      await db
        .update(senders)
        .set({ unreadCount: sql`${senders.unreadCount} + ${delta}` })
        .where(eq(senders.id, email[0].senderId));
    }
  }

  return c.json({ success: true }, 200);
});
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: emails API with sender history, read/unread toggle, and bulk operations"
```

---

## Task 8: Send Email Router

**Files:**
- Modify: `worker/src/routers/send-router.ts`

- [ ] **Step 1: Implement send router**

`worker/src/routers/send-router.ts`:
```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Resend } from "resend";
import { sentEmails } from "../db/sent-emails.schema";
import { senders } from "../db/senders.schema";
import { emails } from "../db/emails.schema";
import { json201Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const sendRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const SendEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string(),
  bodyHtml: z.string(),
  bodyText: z.string().optional(),
});

const SentEmailResponseSchema = z.object({
  id: z.string(),
  resendId: z.string().nullable(),
  status: z.string(),
});

// Compose and send a new email
const sendEmailRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Send"],
  description: "Compose and send a new email via Resend.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: SendEmailSchema,
        },
      },
    },
  },
  responses: {
    ...json201Response(SentEmailResponseSchema, "Email sent"),
  },
});

sendRouter.openapi(sendEmailRoute, async (c) => {
  const db = c.get("db");
  const { to, subject, bodyHtml, bodyText } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);
  const fromAddress = c.env.RESEND_EMAIL_FROM;

  // Send via Resend
  const resend = new Resend(c.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: fromAddress,
    to,
    subject,
    html: bodyHtml,
    text: bodyText,
  });

  // Find sender if they exist
  const existingSender = await db
    .select({ id: senders.id })
    .from(senders)
    .where(eq(senders.email, to))
    .limit(1);

  const senderId = existingSender[0]?.id ?? null;

  // Store sent email
  const id = nanoid();
  await db.insert(sentEmails).values({
    id,
    senderId,
    fromAddress,
    toAddress: to,
    subject,
    bodyHtml,
    bodyText: bodyText ?? null,
    resendId: result.data?.id ?? null,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  return c.json(
    { id, resendId: result.data?.id ?? null, status: result.error ? "failed" : "sent" },
    201
  );
});

// Reply to an existing email
const replyEmailRoute = createRoute({
  method: "post",
  path: "/reply/{emailId}",
  tags: ["Send"],
  description: "Reply to a received email.",
  request: {
    params: z.object({ emailId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            bodyHtml: z.string(),
            bodyText: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(SentEmailResponseSchema, "Reply sent"),
  },
});

sendRouter.openapi(replyEmailRoute, async (c) => {
  const db = c.get("db");
  const { emailId } = c.req.valid("param");
  const { bodyHtml, bodyText } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);
  const fromAddress = c.env.RESEND_EMAIL_FROM;

  // Get the original email
  const original = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  if (original.length === 0) {
    return c.json({ error: "Email not found" }, 404);
  }

  const orig = original[0];

  // Get sender email address
  const sender = await db
    .select({ email: senders.email })
    .from(senders)
    .where(eq(senders.id, orig.senderId))
    .limit(1);

  if (sender.length === 0) {
    return c.json({ error: "Sender not found" }, 404);
  }

  const toAddress = sender[0].email;
  const subject = orig.subject?.startsWith("Re: ")
    ? orig.subject
    : `Re: ${orig.subject || ""}`;

  // Send via Resend
  const resend = new Resend(c.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: fromAddress,
    to: toAddress,
    subject,
    html: bodyHtml,
    text: bodyText,
    headers: orig.messageId ? { "In-Reply-To": orig.messageId } : undefined,
  });

  // Store sent email
  const id = nanoid();
  await db.insert(sentEmails).values({
    id,
    senderId: orig.senderId,
    fromAddress,
    toAddress,
    subject,
    bodyHtml,
    bodyText: bodyText ?? null,
    inReplyTo: orig.messageId,
    resendId: result.data?.id ?? null,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  return c.json(
    { id, resendId: result.data?.id ?? null, status: result.error ? "failed" : "sent" },
    201
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: send and reply email routes via Resend"
```

---

## Task 9: Attachments & Stats Routers

**Files:**
- Modify: `worker/src/routers/attachments-router.ts`
- Modify: `worker/src/routers/stats-router.ts`

- [ ] **Step 1: Implement attachments router**

`worker/src/routers/attachments-router.ts`:
```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { attachments } from "../db/attachments.schema";
import type { Variables } from "../variables";

export const attachmentsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const downloadRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Attachments"],
  description: "Download an attachment from R2.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Redirect to presigned URL or stream the file" },
  },
});

attachmentsRouter.openapi(downloadRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const att = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);

  if (att.length === 0) {
    return c.json({ error: "Attachment not found" }, 404);
  }

  const object = await c.env.R2.get(att[0].r2Key);
  if (!object) {
    return c.json({ error: "File not found in storage" }, 404);
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": att[0].contentType,
      "Content-Disposition": `attachment; filename="${att[0].filename}"`,
      "Content-Length": att[0].size.toString(),
    },
  });
});
```

- [ ] **Step 2: Implement stats router**

`worker/src/routers/stats-router.ts`:
```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { senders } from "../db/senders.schema";
import { emails } from "../db/emails.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const statsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const StatsSchema = z.object({
  totalSenders: z.number(),
  totalEmails: z.number(),
  unreadCount: z.number(),
  recipients: z.array(z.string()),
});

const statsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Stats"],
  description: "Get inbox statistics.",
  request: {
    query: z.object({
      recipient: z.string().optional().openapi({ description: "Filter by recipient address" }),
    }),
  },
  responses: {
    ...json200Response(StatsSchema, "Inbox statistics"),
  },
});

statsRouter.openapi(statsRoute, async (c) => {
  const db = c.get("db");
  const { recipient } = c.req.valid("query");

  let totalEmails: number;
  let unreadCount: number;

  if (recipient) {
    const result = await db
      .select({
        total: sql<number>`COUNT(*)`,
        unread: sql<number>`SUM(CASE WHEN ${emails.isRead} = 0 THEN 1 ELSE 0 END)`,
      })
      .from(emails)
      .where(sql`${emails.recipient} = ${recipient}`);
    totalEmails = result[0]?.total ?? 0;
    unreadCount = result[0]?.unread ?? 0;
  } else {
    const result = await db
      .select({
        total: sql<number>`COUNT(*)`,
        unread: sql<number>`SUM(CASE WHEN ${emails.isRead} = 0 THEN 1 ELSE 0 END)`,
      })
      .from(emails);
    totalEmails = result[0]?.total ?? 0;
    unreadCount = result[0]?.unread ?? 0;
  }

  const senderCount = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(senders);

  // Get distinct recipient addresses
  const recipientRows = await db
    .select({ recipient: emails.recipient })
    .from(emails)
    .groupBy(emails.recipient);

  return c.json(
    {
      totalSenders: senderCount[0]?.count ?? 0,
      totalEmails,
      unreadCount,
      recipients: recipientRows.map((r) => r.recipient),
    },
    200
  );
});
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: attachments download and inbox stats API routes"
```

---

## Task 10: Frontend - Auth & Shell

**Files:**
- Create: `src/pages/LoginPage.tsx`
- Modify: `src/App.tsx`
- Create: `src/lib/api.ts`

- [ ] **Step 1: Install shadcn/ui components**

Run: `npx shadcn@latest add button input card label badge separator scroll-area dialog textarea dropdown-menu avatar`
Expected: Components installed to `src/components/ui/`.

- [ ] **Step 2: Create API client**

`src/lib/api.ts`:
```typescript
export interface Sender {
  id: string;
  email: string;
  name: string | null;
  lastEmailAt: number;
  unreadCount: number;
  totalCount: number;
  latestSubject?: string | null;
}

export interface Email {
  id: string;
  type: "received" | "sent";
  senderId: string | null;
  recipient: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isRead: number | null;
  timestamp: number;
  attachmentCount?: number;
  attachments?: Attachment[];
}

export interface Attachment {
  id: string;
  emailId: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface Stats {
  totalSenders: number;
  totalEmails: number;
  unreadCount: number;
  recipients: string[];
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }
  return res.json();
}

export async function fetchSenders(params?: {
  q?: string;
  recipient?: string;
  page?: number;
  limit?: number;
}): Promise<Sender[]> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.recipient) qs.set("recipient", params.recipient);
  if (params?.page) qs.set("page", params.page.toString());
  if (params?.limit) qs.set("limit", params.limit.toString());
  return apiFetch(`/api/senders?${qs}`);
}

export async function fetchSender(id: string): Promise<Sender> {
  return apiFetch(`/api/senders/${id}`);
}

export async function fetchSenderEmails(
  senderId: string,
  params?: { q?: string; page?: number; limit?: number }
): Promise<Email[]> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.page) qs.set("page", params.page.toString());
  if (params?.limit) qs.set("limit", params.limit.toString());
  return apiFetch(`/api/emails/by-sender/${senderId}?${qs}`);
}

export async function fetchEmail(id: string): Promise<Email> {
  return apiFetch(`/api/emails/${id}`);
}

export async function markEmailRead(id: string, isRead: boolean): Promise<void> {
  await apiFetch(`/api/emails/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isRead }),
  });
}

export async function sendEmail(data: {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
}): Promise<{ id: string }> {
  return apiFetch("/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function replyToEmail(
  emailId: string,
  data: { bodyHtml: string; bodyText?: string }
): Promise<{ id: string }> {
  return apiFetch(`/api/send/reply/${emailId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function fetchStats(recipient?: string): Promise<Stats> {
  const qs = recipient ? `?recipient=${recipient}` : "";
  return apiFetch(`/api/stats${qs}`);
}
```

- [ ] **Step 3: Create LoginPage**

`src/pages/LoginPage.tsx`:
```tsx
import { useState } from "react";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await signIn.emailAndPassword({ email, password });
      if (result.error) {
        setError(result.error.message || "Sign in failed");
      } else {
        window.location.href = "/";
      }
    } catch {
      setError("Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">cmail</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
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
              />
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Update App.tsx with routing and auth guard**

`src/App.tsx`:
```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import LoginPage from "@/pages/LoginPage";
import InboxPage from "@/pages/InboxPage";

const queryClient = new QueryClient();

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();

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

  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
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

- [ ] **Step 5: Create placeholder InboxPage**

`src/pages/InboxPage.tsx`:
```tsx
export default function InboxPage() {
  return <div className="flex h-screen">Inbox coming soon</div>;
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: auth flow, API client, login page, and app routing"
```

---

## Task 11: Frontend - Sender List (Left Panel)

**Files:**
- Create: `src/pages/SenderList.tsx`
- Modify: `src/pages/InboxPage.tsx`

- [ ] **Step 1: Create SenderList component**

`src/pages/SenderList.tsx`:
```tsx
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { fetchSenders, fetchStats, type Sender } from "@/lib/api";

interface SenderListProps {
  selectedSenderId: string | null;
  onSelectSender: (sender: Sender) => void;
}

export default function SenderList({ selectedSenderId, onSelectSender }: SenderListProps) {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [search, setSearch] = useState("");
  const [recipient, setRecipient] = useState<string>("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats().then((stats) => setRecipients(stats.recipients));
  }, []);

  useEffect(() => {
    setLoading(true);
    const timeout = setTimeout(() => {
      fetchSenders({
        q: search || undefined,
        recipient: recipient || undefined,
      })
        .then(setSenders)
        .finally(() => setLoading(false));
    }, 200); // debounce
    return () => clearTimeout(timeout);
  }, [search, recipient]);

  function formatTime(ts: number) {
    const date = new Date(ts * 1000);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return (
    <div className="flex h-full flex-col border-r">
      <div className="space-y-2 p-3">
        <Input
          placeholder="Search senders..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {recipients.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start text-sm">
                {recipient || "All addresses"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setRecipient("")}>
                All addresses
              </DropdownMenuItem>
              {recipients.map((r) => (
                <DropdownMenuItem key={r} onClick={() => setRecipient(r)}>
                  {r}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <p className="p-4 text-center text-sm text-neutral-500">Loading...</p>
        ) : senders.length === 0 ? (
          <p className="p-4 text-center text-sm text-neutral-500">No senders found</p>
        ) : (
          senders.map((sender) => (
            <button
              key={sender.id}
              onClick={() => onSelectSender(sender)}
              className={`w-full border-b px-4 py-3 text-left transition-colors hover:bg-neutral-50 ${
                selectedSenderId === sender.id ? "bg-neutral-100" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`truncate text-sm ${
                    sender.unreadCount > 0 ? "font-semibold" : ""
                  }`}
                >
                  {sender.name || sender.email}
                </span>
                <span className="ml-2 shrink-0 text-xs text-neutral-400">
                  {formatTime(sender.lastEmailAt)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                {sender.name && (
                  <span className="truncate text-xs text-neutral-500">{sender.email}</span>
                )}
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="truncate text-xs text-neutral-400">
                  {sender.latestSubject || "(no subject)"}
                </span>
                {sender.unreadCount > 0 && (
                  <Badge variant="default" className="ml-2 shrink-0 text-xs">
                    {sender.unreadCount}
                  </Badge>
                )}
              </div>
            </button>
          ))
        )}
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 2: Update InboxPage with two-panel layout**

`src/pages/InboxPage.tsx`:
```tsx
import { useState } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SenderList from "./SenderList";
import SenderDetail from "./SenderDetail";
import ComposeModal from "./ComposeModal";
import type { Sender } from "@/lib/api";

export default function InboxPage() {
  const { data: session } = useSession();
  const [selectedSender, setSelectedSender] = useState<Sender | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);

  function handleCompose() {
    setReplyToEmailId(null);
    setComposeOpen(true);
  }

  function handleReply(emailId: string) {
    setReplyToEmailId(emailId);
    setComposeOpen(true);
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Top nav */}
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-lg font-semibold">cmail</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleCompose}>
            Compose
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                {session?.user?.email}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => signOut()}>
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Two-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-80 shrink-0">
          <SenderList
            selectedSenderId={selectedSender?.id ?? null}
            onSelectSender={setSelectedSender}
          />
        </div>
        <div className="flex-1">
          {selectedSender ? (
            <SenderDetail sender={selectedSender} onReply={handleReply} />
          ) : (
            <div className="flex h-full items-center justify-center text-neutral-400">
              Select a sender to view emails
            </div>
          )}
        </div>
      </div>

      {/* Compose modal */}
      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        replyToEmailId={replyToEmailId}
      />
    </div>
  );
}
```

- [ ] **Step 3: Create placeholder SenderDetail and ComposeModal**

`src/pages/SenderDetail.tsx`:
```tsx
import type { Sender } from "@/lib/api";

interface SenderDetailProps {
  sender: Sender;
  onReply: (emailId: string) => void;
}

export default function SenderDetail({ sender }: SenderDetailProps) {
  return <div className="p-4">Emails from {sender.name || sender.email} — coming next</div>;
}
```

`src/pages/ComposeModal.tsx`:
```tsx
interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  replyToEmailId: string | null;
}

export default function ComposeModal({ open }: ComposeModalProps) {
  if (!open) return null;
  return <div>Compose — coming soon</div>;
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: sender list panel with search, recipient filter, and inbox layout"
```

---

## Task 12: Frontend - Sender Detail (Right Panel)

**Files:**
- Modify: `src/pages/SenderDetail.tsx`

- [ ] **Step 1: Implement SenderDetail with email history**

`src/pages/SenderDetail.tsx`:
```tsx
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  fetchSenderEmails,
  markEmailRead,
  type Sender,
  type Email,
} from "@/lib/api";

interface SenderDetailProps {
  sender: Sender;
  onReply: (emailId: string) => void;
}

export default function SenderDetail({ sender, onReply }: SenderDetailProps) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setExpandedId(null);
    fetchSenderEmails(sender.id)
      .then(setEmails)
      .finally(() => setLoading(false));
  }, [sender.id]);

  async function handleExpand(email: Email) {
    if (expandedId === email.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(email.id);
    // Mark as read if received and unread
    if (email.type === "received" && email.isRead === 0) {
      await markEmailRead(email.id, true);
      setEmails((prev) =>
        prev.map((e) => (e.id === email.id ? { ...e, isRead: 1 } : e))
      );
    }
  }

  async function handleToggleRead(e: React.MouseEvent, email: Email) {
    e.stopPropagation();
    if (email.type !== "received") return;
    const newIsRead = email.isRead === 0;
    await markEmailRead(email.id, newIsRead);
    setEmails((prev) =>
      prev.map((em) =>
        em.id === email.id ? { ...em, isRead: newIsRead ? 1 : 0 } : em
      )
    );
  }

  function formatDate(ts: number) {
    return new Date(ts * 1000).toLocaleString();
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-500">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Sender header */}
      <div className="border-b px-6 py-4">
        <h2 className="text-lg font-semibold">
          {sender.name || sender.email}
        </h2>
        {sender.name && (
          <p className="text-sm text-neutral-500">{sender.email}</p>
        )}
        <p className="text-xs text-neutral-400">
          {sender.totalCount} email{sender.totalCount !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Email list */}
      <ScrollArea className="flex-1">
        {emails.map((email) => (
          <div key={email.id}>
            <button
              onClick={() => handleExpand(email)}
              className={`w-full px-6 py-3 text-left transition-colors hover:bg-neutral-50 ${
                expandedId === email.id ? "bg-neutral-50" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                {email.type === "sent" && (
                  <Badge variant="outline" className="text-xs">
                    Sent
                  </Badge>
                )}
                <span
                  className={`flex-1 truncate text-sm ${
                    email.type === "received" && email.isRead === 0
                      ? "font-semibold"
                      : ""
                  }`}
                >
                  {email.subject || "(no subject)"}
                </span>
                {email.type === "received" && (email.attachmentCount ?? 0) > 0 && (
                  <span className="text-xs text-neutral-400">
                    {email.attachmentCount} file{email.attachmentCount !== 1 ? "s" : ""}
                  </span>
                )}
                <span className="shrink-0 text-xs text-neutral-400">
                  {formatDate(email.timestamp)}
                </span>
              </div>
            </button>

            {/* Expanded email body */}
            {expandedId === email.id && (
              <div className="border-t bg-white px-6 py-4">
                <div className="mb-3 flex items-center gap-2">
                  {email.type === "received" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onReply(email.id)}
                      >
                        Reply
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => handleToggleRead(e, email)}
                      >
                        Mark {email.isRead ? "unread" : "read"}
                      </Button>
                    </>
                  )}
                  {email.type === "sent" && email.toAddress && (
                    <span className="text-xs text-neutral-500">
                      To: {email.toAddress}
                    </span>
                  )}
                  {email.type === "received" && email.recipient && (
                    <span className="text-xs text-neutral-500">
                      To: {email.recipient}
                    </span>
                  )}
                </div>
                {email.bodyHtml ? (
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: email.bodyHtml }}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap text-sm">
                    {email.bodyText || "(empty)"}
                  </pre>
                )}
                {/* Attachments */}
                {email.type === "received" &&
                  email.attachments &&
                  email.attachments.length > 0 && (
                    <div className="mt-4">
                      <Separator className="mb-3" />
                      <p className="mb-2 text-xs font-medium text-neutral-500">
                        Attachments
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {email.attachments.map((att) => (
                          <a
                            key={att.id}
                            href={`/api/attachments/${att.id}`}
                            className="rounded border px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50"
                          >
                            {att.filename} ({Math.round(att.size / 1024)}KB)
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            )}
            <Separator />
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: sender detail panel with email history, expand, read/unread, attachments"
```

---

## Task 13: Frontend - Compose & Reply Modal

**Files:**
- Modify: `src/pages/ComposeModal.tsx`

- [ ] **Step 1: Implement ComposeModal**

`src/pages/ComposeModal.tsx`:
```tsx
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { sendEmail, replyToEmail, fetchEmail } from "@/lib/api";

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  replyToEmailId: string | null;
}

export default function ComposeModal({
  open,
  onClose,
  replyToEmailId,
}: ComposeModalProps) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const isReply = replyToEmailId !== null;

  useEffect(() => {
    if (!open) {
      setTo("");
      setSubject("");
      setBody("");
      setError("");
      return;
    }
    if (replyToEmailId) {
      fetchEmail(replyToEmailId).then((email) => {
        setSubject(
          email.subject?.startsWith("Re: ")
            ? email.subject
            : `Re: ${email.subject || ""}`
        );
      });
    }
  }, [open, replyToEmailId]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError("");
    try {
      if (isReply) {
        await replyToEmail(replyToEmailId!, {
          bodyHtml: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
          bodyText: body,
        });
      } else {
        await sendEmail({
          to,
          subject,
          bodyHtml: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
          bodyText: body,
        });
      }
      onClose();
    } catch {
      setError("Failed to send email");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isReply ? "Reply" : "Compose"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSend} className="space-y-4">
          {!isReply && (
            <div className="space-y-2">
              <Label htmlFor="to">To</Label>
              <Input
                id="to"
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                required
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required={!isReply}
              disabled={isReply}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="body">Message</Label>
            <Textarea
              id="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              required
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={sending}>
              {sending ? "Sending..." : "Send"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: compose and reply email modal"
```

---

## Task 14: Final Wiring & Cleanup

**Files:**
- Verify all imports and routes compile
- Update CORS origins in worker entry if needed

- [ ] **Step 1: Verify the full build**

Run: `yarn build`
Expected: Successful build with no errors. Both frontend and worker compile.

- [ ] **Step 2: Run dev server**

Run: `yarn dev`
Expected: Dev server starts on port 8080. Frontend loads. API routes respond (will get auth errors without a user, which is correct).

- [ ] **Step 3: Apply migrations locally**

Run: `yarn db:migrate:dev`
Expected: Migrations applied to local D1 SQLite.

- [ ] **Step 4: Create first admin user**

This requires running wrangler dev and using the BetterAuth API directly. The first user will need to be created via the API and then promoted to admin via D1 directly:

```bash
# In a separate terminal with dev server running:
curl -X POST http://localhost:8080/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"changeme","name":"Admin"}'
```

Then promote to admin via D1:
```bash
wrangler d1 execute cmail-db --local --command "UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'"
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete cmail MVP with email receiving, viewing, and sending"
```
