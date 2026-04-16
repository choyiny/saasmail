# Sender Display Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to configure a display name per email address so outgoing emails show "Jane Smith <jane@custom-domain.com>" instead of just "jane@custom-domain.com".

**Architecture:** Add a `sender_identities` table that maps email addresses to display names. The stats API already returns the list of recipient addresses — extend it to return display names too. All sending paths (compose, reply, sequence) format the `from` field as `"Display Name <email>"` using the Resend API's supported format. No migration of existing data needed — addresses without a configured name continue to work as bare email addresses.

**Tech Stack:** Drizzle ORM (D1), Hono + Zod OpenAPI routes, React frontend, Resend API

---

### Task 1: Create `sender_identities` schema and migration

**Files:**
- Create: `worker/src/db/sender-identities.schema.ts`
- Modify: `worker/src/db/schema.ts`

- [ ] **Step 1: Create the schema file**

```typescript
// worker/src/db/sender-identities.schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const senderIdentities = sqliteTable("sender_identities", {
  email: text("email").primaryKey(),
  displayName: text("display_name").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

- [ ] **Step 2: Register in barrel export**

Read `worker/src/db/schema.ts` and add:

```typescript
export * from "./sender-identities.schema";
```

Also add `senderIdentities` to the `schema` object if one exists.

- [ ] **Step 3: Generate the migration**

Run: `yarn drizzle-kit generate`

Expected: A new SQL migration file appears in `migrations/` creating `sender_identities` table.

- [ ] **Step 4: Verify migration SQL**

Read the generated migration file. It should contain:
```sql
CREATE TABLE `sender_identities` (
  `email` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/db/sender-identities.schema.ts worker/src/db/schema.ts migrations/
git commit -m "feat: add sender_identities table for display names"
```

---

### Task 2: Create sender identities CRUD router

**Files:**
- Create: `worker/src/routers/sender-identities-router.ts`
- Modify: `worker/src/index.ts` (register the router)

- [ ] **Step 1: Create the router with list and upsert endpoints**

```typescript
// worker/src/routers/sender-identities-router.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { senderIdentities } from "../db/sender-identities.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const senderIdentitiesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const SenderIdentitySchema = z.object({
  email: z.string().email(),
  displayName: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// GET /api/sender-identities — list all
const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Sender Identities"],
  description: "List all sender identities.",
  responses: {
    ...json200Response(z.array(SenderIdentitySchema), "Sender identities"),
  },
});

senderIdentitiesRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const rows = await db.select().from(senderIdentities);
  return c.json(rows, 200);
});

// PUT /api/sender-identities/:email — upsert
const upsertRoute = createRoute({
  method: "put",
  path: "/{email}",
  tags: ["Sender Identities"],
  description: "Set display name for a sender email address.",
  request: {
    params: z.object({ email: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ displayName: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    ...json200Response(SenderIdentitySchema, "Sender identity saved"),
  },
});

senderIdentitiesRouter.openapi(upsertRoute, async (c) => {
  const db = c.get("db");
  const { email } = c.req.valid("param");
  const { displayName } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  await db
    .insert(senderIdentities)
    .values({ email, displayName, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: senderIdentities.email,
      set: { displayName, updatedAt: now },
    });

  const rows = await db
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.email, email))
    .limit(1);

  return c.json(rows[0], 200);
});

// DELETE /api/sender-identities/:email
const deleteRoute = createRoute({
  method: "delete",
  path: "/{email}",
  tags: ["Sender Identities"],
  description: "Remove display name for a sender email address.",
  request: {
    params: z.object({ email: z.string() }),
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Deleted"),
  },
});

senderIdentitiesRouter.openapi(deleteRoute, async (c) => {
  const db = c.get("db");
  const { email } = c.req.valid("param");
  await db.delete(senderIdentities).where(eq(senderIdentities.email, email));
  return c.json({ success: true }, 200);
});
```

- [ ] **Step 2: Register the router in index.ts**

Read `worker/src/index.ts` and add:

```typescript
import { senderIdentitiesRouter } from "./routers/sender-identities-router";
```

And mount it alongside other routers:

```typescript
app.route("/api/sender-identities", senderIdentitiesRouter);
```

- [ ] **Step 3: Type-check**

Run: `yarn tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add worker/src/routers/sender-identities-router.ts worker/src/index.ts
git commit -m "feat: add sender identities CRUD endpoints"
```

---

### Task 3: Create `formatFromAddress` helper and use it in all sending paths

**Files:**
- Create: `worker/src/lib/format-from-address.ts`
- Modify: `worker/src/routers/send-router.ts`
- Modify: `worker/src/lib/sequence-processor.ts`

- [ ] **Step 1: Create the helper**

```typescript
// worker/src/lib/format-from-address.ts
import { eq } from "drizzle-orm";
import { senderIdentities } from "../db/sender-identities.schema";

/**
 * Looks up the display name for an email address and returns
 * a formatted "From" string for the Resend API.
 *
 * Returns "Display Name <email>" if a display name is configured,
 * otherwise returns the bare email address.
 */
export async function formatFromAddress(
  db: Parameters<typeof db.select>[0] extends never ? never : any,
  email: string,
): Promise<string> {
  const rows = await db
    .select({ displayName: senderIdentities.displayName })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, email))
    .limit(1);

  if (rows.length > 0 && rows[0].displayName) {
    return `${rows[0].displayName} <${email}>`;
  }
  return email;
}
```

Note: The `db` parameter type should match the drizzle instance type used throughout the codebase. Check `worker/src/variables.ts` or how `c.get("db")` is typed and use the same type.

- [ ] **Step 2: Use in send-router.ts compose handler**

In `send-router.ts`, import the helper:

```typescript
import { formatFromAddress } from "../lib/format-from-address";
```

In the compose handler (around line 56-66), replace:

```typescript
const result = await resend.emails.send({
  from: fromAddress,
```

with:

```typescript
const formattedFrom = await formatFromAddress(db, fromAddress);
const result = await resend.emails.send({
  from: formattedFrom,
```

Keep storing the bare `fromAddress` in the `sentEmails` record (don't store the display name there).

- [ ] **Step 3: Use in send-router.ts reply handler**

In the reply handler (around line 221-228), replace:

```typescript
const result = await resend.emails.send({
  from: fromAddress,
```

with:

```typescript
const formattedFrom = await formatFromAddress(db, fromAddress);
const result = await resend.emails.send({
  from: formattedFrom,
```

- [ ] **Step 4: Use in sequence-processor.ts**

In `sequence-processor.ts`, import the helper:

```typescript
import { formatFromAddress } from "./format-from-address";
```

In `processSequenceEmail` (around line 163), replace:

```typescript
const result = await resend.emails.send({
  from: fromAddress,
```

with:

```typescript
const formattedFrom = await formatFromAddress(db, fromAddress);
const result = await resend.emails.send({
  from: formattedFrom,
```

- [ ] **Step 5: Type-check**

Run: `yarn tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/format-from-address.ts worker/src/routers/send-router.ts worker/src/lib/sequence-processor.ts
git commit -m "feat: format From header with display name from sender identities"
```

---

### Task 4: Extend stats API to return sender identities alongside recipients

**Files:**
- Modify: `worker/src/routers/stats-router.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Update stats router to include display names**

In `stats-router.ts`, import the schema:

```typescript
import { senderIdentities } from "../db/sender-identities.schema";
import { eq } from "drizzle-orm";
```

Update the `StatsSchema` to include a richer recipients structure:

```typescript
const StatsSchema = z.object({
  totalPeople: z.number(),
  totalEmails: z.number(),
  unreadCount: z.number(),
  recipients: z.array(z.string()),
  senderIdentities: z.array(
    z.object({
      email: z.string(),
      displayName: z.string(),
    }),
  ),
});
```

In the handler, after fetching `recipientRows`, fetch identities:

```typescript
const identityRows = await db.select().from(senderIdentities);
```

Add to the response:

```typescript
return c.json(
  {
    totalPeople: personCount[0]?.count ?? 0,
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
```

- [ ] **Step 2: Update frontend Stats type**

In `src/lib/api.ts`, update the `Stats` interface:

```typescript
export interface Stats {
  totalPeople: number;
  totalEmails: number;
  unreadCount: number;
  recipients: string[];
  senderIdentities: Array<{ email: string; displayName: string }>;
}
```

- [ ] **Step 3: Type-check**

Run: `yarn tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add worker/src/routers/stats-router.ts src/lib/api.ts
git commit -m "feat: include sender identities in stats API response"
```

---

### Task 5: Update frontend From dropdowns to show display names

**Files:**
- Modify: `src/pages/ComposeModal.tsx`
- Modify: `src/components/ReplyComposer.tsx`

- [ ] **Step 1: Update ComposeModal to show display names**

In `ComposeModal.tsx`, update the stats fetch to also store `senderIdentities`:

```typescript
const [senderIdentities, setSenderIdentities] = useState<
  Array<{ email: string; displayName: string }>
>([]);
```

In the `useEffect` that fetches stats:

```typescript
fetchStats().then((stats) => {
  setRecipients(stats.recipients);
  setSenderIdentities(stats.senderIdentities ?? []);
  if (!fromAddress && stats.recipients.length > 0) {
    setFromAddress(stats.recipients[0]);
  }
});
```

Create a helper to get display label:

```typescript
function getFromLabel(email: string): string {
  const identity = senderIdentities.find((s) => s.email === email);
  return identity ? `${identity.displayName} <${email}>` : email;
}
```

Update the `<select>` options to use the label:

```tsx
{recipients.map((r) => (
  <option key={r} value={r}>
    {getFromLabel(r)}
  </option>
))}
```

- [ ] **Step 2: Update ReplyComposer to accept and show display names**

Add `senderIdentities` to the `ReplyComposerProps` interface:

```typescript
interface ReplyComposerProps {
  emailId: string;
  personName: string | null;
  personEmail: string;
  recipients: string[];
  senderIdentities: Array<{ email: string; displayName: string }>;
  onClose: () => void;
  onSent: () => void;
}
```

Destructure it and create the same helper:

```typescript
function getFromLabel(email: string): string {
  const identity = senderIdentities.find((s) => s.email === email);
  return identity ? `${identity.displayName} <${email}>` : email;
}
```

Update the `<select>` options the same way.

- [ ] **Step 3: Pass senderIdentities to ReplyComposer from parent**

Find where `ReplyComposer` is rendered (likely in the email detail/thread page) and pass the `senderIdentities` prop. The parent already has access to stats — thread the prop through.

- [ ] **Step 4: Type-check**

Run: `yarn tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/pages/ComposeModal.tsx src/components/ReplyComposer.tsx
git commit -m "feat: show display names in From dropdown for compose and reply"
```

---

### Task 6: Add Settings UI for managing sender identities

**Files:**
- Create: `src/components/SenderIdentitiesSettings.tsx`
- Modify: `src/lib/api.ts` (add API functions)
- Modify: Settings page (wherever settings are rendered)

- [ ] **Step 1: Add API functions**

In `src/lib/api.ts`, add:

```typescript
export interface SenderIdentity {
  email: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

export async function fetchSenderIdentities(): Promise<SenderIdentity[]> {
  return apiFetch("/api/sender-identities");
}

export async function upsertSenderIdentity(
  email: string,
  displayName: string,
): Promise<SenderIdentity> {
  return apiFetch(`/api/sender-identities/${encodeURIComponent(email)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
}

export async function deleteSenderIdentity(
  email: string,
): Promise<{ success: boolean }> {
  return apiFetch(`/api/sender-identities/${encodeURIComponent(email)}`, {
    method: "DELETE",
  });
}
```

- [ ] **Step 2: Create SenderIdentitiesSettings component**

Create `src/components/SenderIdentitiesSettings.tsx`. This component should:

1. Fetch the list of recipients from stats (these are the available email addresses)
2. Fetch current sender identities
3. Show each recipient email with an editable display name field next to it
4. Save on blur or button click via `upsertSenderIdentity`
5. Allow clearing a display name via `deleteSenderIdentity`

Keep the UI consistent with existing settings components in the project. Use the same Tailwind classes and patterns.

- [ ] **Step 3: Add to settings page**

Find the settings page and add a "Sender Names" or "Display Names" section that renders `<SenderIdentitiesSettings />`.

- [ ] **Step 4: Type-check**

Run: `yarn tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Test manually**

1. Open settings, verify email addresses appear
2. Set a display name for one address
3. Compose a new email — verify the From dropdown shows "Name <email>"
4. Send an email — verify it arrives with the display name in the From header

- [ ] **Step 6: Commit**

```bash
git add src/components/SenderIdentitiesSettings.tsx src/lib/api.ts
git commit -m "feat: add settings UI for managing sender display names"
```
