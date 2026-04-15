# Inbox Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix inline image display, redesign sender detail as a Slack-style conversation with chat bubbles, and render full HTML emails in a white-background modal.

**Architecture:** Add `contentId` to attachments for CID mapping, rewrite CID URLs in email HTML at ingest time, add inline attachment serving endpoint, then rebuild the SenderDetail component as a chat-style conversation with a separate HTML preview modal.

**Tech Stack:** Drizzle (schema + migration), postal-mime (CID extraction), DOMPurify (HTML sanitization), React + Tailwind (conversation UI), Radix Dialog (HTML preview modal)

---

## File Structure

### New files

| File                                | Responsibility                                      |
| ----------------------------------- | --------------------------------------------------- |
| `src/components/EmailHtmlModal.tsx` | Full HTML email preview modal with white background |
| `src/components/MessageBubble.tsx`  | Single chat bubble for a received or sent email     |

### Modified files

| File                                       | Change                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `worker/src/db/attachments.schema.ts`      | Add `contentId` column                                                           |
| `worker/src/lib/email-parser.ts`           | Extract `contentId` from postal-mime attachments                                 |
| `worker/src/email-handler.ts`              | Store contentId, rewrite CID URLs in bodyHtml                                    |
| `worker/src/routers/attachments-router.ts` | Add inline serving endpoint                                                      |
| `worker/src/routers/emails-router.ts`      | Add `recipient` query filter to by-sender endpoint, return attachments list      |
| `src/pages/SenderDetail.tsx`               | Complete rewrite to Slack-style conversation                                     |
| `src/lib/api.ts`                           | Update `fetchSenderEmails` to accept `recipient` param, update `Attachment` type |

---

## Task 1: Add contentId to Attachments Schema

**Files:**

- Modify: `worker/src/db/attachments.schema.ts`

- [ ] **Step 1: Add contentId column**

Replace the file with:

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  emailId: text("email_id").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  r2Key: text("r2_key").notNull(),
  contentId: text("content_id"),
  createdAt: integer("created_at").notNull(),
});
```

- [ ] **Step 2: Generate and apply migration**

Run: `yarn db:generate`
Then: `yarn db:migrate:dev`

- [ ] **Step 3: Commit**

```bash
git add worker/src/db/attachments.schema.ts migrations/
git commit -m "feat: add contentId column to attachments schema"
```

---

## Task 2: Extract Content-ID in Email Parser

**Files:**

- Modify: `worker/src/lib/email-parser.ts`

- [ ] **Step 1: Add contentId to ParsedAttachment and extraction**

Replace the file with:

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
  contentId: string | null;
}

export async function parseEmail(
  message: ForwardableEmailMessage,
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
      contentId: att.contentId || null,
    })),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/lib/email-parser.ts
git commit -m "feat: extract contentId from parsed email attachments"
```

---

## Task 3: Store contentId and Rewrite CID URLs in Email Handler

**Files:**

- Modify: `worker/src/email-handler.ts`

- [ ] **Step 1: Update the email handler**

Replace the file with:

```typescript
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schema } from "./db/schema";
import { senders } from "./db/senders.schema";
import { emails } from "./db/emails.schema";
import { attachments } from "./db/attachments.schema";
import { parseEmail } from "./lib/email-parser";
import { cancelSequencesForSender } from "./lib/cancel-sequence";

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: CloudflareBindings,
  ctx: ExecutionContext,
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
  const senderId = nanoid();
  await db
    .insert(senders)
    .values({
      id: senderId,
      email: parsed.from.address,
      name: parsed.from.name || null,
      lastEmailAt: now,
      unreadCount: 1,
      totalCount: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: senders.email,
      set: {
        name: sql`COALESCE(${parsed.from.name || null}, ${senders.name})`,
        lastEmailAt: now,
        unreadCount: sql`${senders.unreadCount} + 1`,
        totalCount: sql`${senders.totalCount} + 1`,
        updatedAt: now,
      },
    });

  // Get the actual sender ID (could be existing)
  const senderRow = await db
    .select({ id: senders.id })
    .from(senders)
    .where(eq(senders.email, parsed.from.address))
    .limit(1);
  const actualSenderId = senderRow[0]!.id;

  // Process attachments first (need IDs for CID rewriting)
  const cidMap: Record<string, string> = {}; // contentId -> attachmentId
  const emailId = nanoid();

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
      contentId: att.contentId,
      createdAt: now,
    });

    if (att.contentId) {
      // Strip angle brackets from Content-ID (e.g., "<image001>" -> "image001")
      const cleanCid = att.contentId.replace(/^<|>$/g, "");
      cidMap[cleanCid] = attachmentId;
    }
  }

  // Rewrite CID references in HTML body
  let bodyHtml = parsed.bodyHtml;
  if (bodyHtml && Object.keys(cidMap).length > 0) {
    for (const [cid, attachmentId] of Object.entries(cidMap)) {
      bodyHtml = bodyHtml.replace(
        new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"),
        `/api/attachments/${attachmentId}/inline`,
      );
    }
  }

  // Insert email (with rewritten HTML)
  await db.insert(emails).values({
    id: emailId,
    senderId: actualSenderId,
    recipient: parsed.to,
    subject: parsed.subject,
    bodyHtml,
    bodyText: parsed.bodyText,
    rawHeaders: JSON.stringify(parsed.headers),
    messageId: parsed.messageId,
    isRead: 0,
    receivedAt: now,
    createdAt: now,
  });

  // Cancel any active sequences for this sender
  await cancelSequencesForSender(db, actualSenderId);

  console.log(
    `Processed email from ${parsed.from.address} to ${parsed.to} (${parsed.attachments.length} attachments)`,
  );
}
```

Key changes from the original:

- Process attachments BEFORE inserting the email (need attachment IDs for CID rewriting)
- Build a `cidMap` of Content-ID → attachment ID
- Strip angle brackets from Content-ID values
- Replace `cid:xxx` references in bodyHtml with `/api/attachments/{id}/inline`
- Store `contentId` in the attachments table

- [ ] **Step 2: Commit**

```bash
git add worker/src/email-handler.ts
git commit -m "feat: store contentId and rewrite CID URLs in email handler"
```

---

## Task 4: Add Inline Attachment Serving Endpoint

**Files:**

- Modify: `worker/src/routers/attachments-router.ts`

- [ ] **Step 1: Add the inline endpoint**

Replace the file with:

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
    200: { description: "Attachment file" },
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

// Serve attachment inline (for CID images in email HTML)
const inlineRoute = createRoute({
  method: "get",
  path: "/{id}/inline",
  tags: ["Attachments"],
  description: "Serve an attachment inline (for embedded images).",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Inline attachment" },
  },
});

attachmentsRouter.openapi(inlineRoute, async (c) => {
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
      "Content-Disposition": "inline",
      "Content-Length": att[0].size.toString(),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/routers/attachments-router.ts
git commit -m "feat: add inline attachment serving endpoint for CID images"
```

---

## Task 5: Add Recipient Filter to Emails-by-Sender Endpoint

**Files:**

- Modify: `worker/src/routers/emails-router.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add recipient query param to the by-sender endpoint**

In `worker/src/routers/emails-router.ts`, update the query schema for `listSenderEmailsRoute` (line 38-42). Change:

```typescript
    query: z.object({
      q: z.string().optional().openapi({ description: "Search by subject" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
```

To:

```typescript
    query: z.object({
      q: z.string().optional().openapi({ description: "Search by subject" }),
      recipient: z.string().optional().openapi({ description: "Filter by recipient address" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
```

- [ ] **Step 2: Add recipient filtering logic to the handler**

In the handler (line 49+), after extracting query params, add recipient to the destructured params:

Change line 52:

```typescript
const { q, page, limit } = c.req.valid("query");
```

To:

```typescript
const { q, recipient, page, limit } = c.req.valid("query");
```

Add recipient condition to received emails (after line 58):

```typescript
if (recipient) {
  receivedConditions.push(eq(emails.recipient, recipient));
}
```

Add recipient condition to sent emails (after line 78):

```typescript
if (recipient) {
  sentConditions.push(eq(sentEmails.toAddress, recipient));
}
```

- [ ] **Step 3: Also return attachments list for received emails**

In the handler, after the attachment counts section (after line 146), add a query to fetch actual attachment records for the paginated received emails:

```typescript
// Fetch attachment details for received emails (excluding inline)
let attachmentDetails: Record<string, any[]> = {};
if (receivedIds.length > 0) {
  const attRows = await db
    .select()
    .from(attachments)
    .where(
      sql`${attachments.emailId} IN (${sql.join(
        receivedIds.map((id) => sql`${id}`),
        sql`,`,
      )})`,
    );

  for (const att of attRows) {
    if (!attachmentDetails[att.emailId]) {
      attachmentDetails[att.emailId] = [];
    }
    attachmentDetails[att.emailId].push(att);
  }
}
```

Then update the result mapping (line 148-151) to include attachments:

```typescript
const result = paginated.map((e) => ({
  ...e,
  attachmentCount: attachmentCounts[e.id] ?? 0,
  attachments: attachmentDetails[e.id] ?? [],
}));
```

- [ ] **Step 4: Update frontend API client**

In `src/lib/api.ts`, update `fetchSenderEmails` to accept `recipient`:

Change:

```typescript
export async function fetchSenderEmails(
  senderId: string,
  params?: { q?: string; page?: number; limit?: number }
): Promise<Email[]> {
```

To:

```typescript
export async function fetchSenderEmails(
  senderId: string,
  params?: { q?: string; recipient?: string; page?: number; limit?: number }
): Promise<Email[]> {
```

And add the recipient param to the query string builder:

```typescript
if (params?.recipient) qs.set("recipient", params.recipient);
```

Also update the `Attachment` interface to include `contentId`:

```typescript
export interface Attachment {
  id: string;
  emailId: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
}
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/routers/emails-router.ts src/lib/api.ts
git commit -m "feat: add recipient filter and attachment details to emails endpoint"
```

---

## Task 6: Email HTML Preview Modal Component

**Files:**

- Create: `src/components/EmailHtmlModal.tsx`

- [ ] **Step 1: Create the modal**

```tsx
import DOMPurify from "dompurify";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Email } from "@/lib/api";

interface EmailHtmlModalProps {
  email: Email | null;
  open: boolean;
  onClose: () => void;
}

export default function EmailHtmlModal({
  email,
  open,
  onClose,
}: EmailHtmlModalProps) {
  if (!email) return null;

  const senderLabel =
    email.type === "sent"
      ? `You → ${email.toAddress}`
      : (email.fromAddress ?? email.recipient ?? "Unknown");

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden border-border-dark bg-card p-0 text-text-primary">
        <DialogHeader className="border-b border-border-dark px-6 py-4">
          <DialogTitle className="text-sm text-text-primary">
            {email.subject || "(no subject)"}
          </DialogTitle>
          <p className="text-xs text-text-secondary">{senderLabel}</p>
          <p className="text-[11px] text-text-tertiary">
            {new Date(email.timestamp * 1000).toLocaleString()}
          </p>
        </DialogHeader>
        <div
          className="overflow-auto"
          style={{ maxHeight: "calc(90vh - 120px)" }}
        >
          {email.bodyHtml ? (
            <div
              className="prose prose-sm max-w-none bg-white p-6 text-black"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(email.bodyHtml, {
                  ADD_TAGS: ["style"],
                  ADD_ATTR: ["target"],
                }),
              }}
            />
          ) : (
            <pre className="whitespace-pre-wrap bg-white p-6 text-sm text-black">
              {email.bodyText || "(empty)"}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/EmailHtmlModal.tsx
git commit -m "feat: add email HTML preview modal with white background"
```

---

## Task 7: Message Bubble Component

**Files:**

- Create: `src/components/MessageBubble.tsx`

- [ ] **Step 1: Create the bubble component**

```tsx
import { useState } from "react";
import { Maximize2, Paperclip } from "lucide-react";
import type { Email } from "@/lib/api";

interface MessageBubbleProps {
  email: Email;
  senderEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
}

const MAX_LINES = 4;
const APPROX_CHARS_PER_LINE = 80;
const TRUNCATE_LENGTH = MAX_LINES * APPROX_CHARS_PER_LINE;

export default function MessageBubble({
  email,
  senderEmail,
  onOpenHtml,
  onMarkRead,
  onReply,
}: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const isSent = email.type === "sent";
  const isUnread = email.type === "received" && email.isRead === 0;

  const text = email.bodyText || "";
  const isTruncated = text.length > TRUNCATE_LENGTH && !expanded;
  const displayText = isTruncated
    ? text.slice(0, TRUNCATE_LENGTH).trimEnd() + "..."
    : text;

  const attribution = isSent
    ? `You${email.fromAddress ? ` (${email.fromAddress})` : ""}`
    : senderEmail;

  const timestamp = new Date(email.timestamp * 1000);
  const timeStr = timestamp.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateStr = timestamp.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });

  // Filter to non-inline attachments only
  const downloadableAttachments = (email.attachments ?? []).filter(
    (att) => !att.contentId,
  );

  function handleBubbleClick() {
    if (isUnread) {
      onMarkRead(email);
    }
  }

  return (
    <div
      className={`flex ${isSent ? "justify-end" : "justify-start"} px-4 py-1.5`}
    >
      <div
        className={`group relative max-w-[75%] rounded-xl px-4 py-2.5 ${
          isSent
            ? "bg-accent/20 text-text-primary"
            : isUnread
              ? "bg-card border border-accent/30 text-text-primary"
              : "bg-card text-text-primary"
        }`}
        onClick={handleBubbleClick}
      >
        {/* Attribution + time */}
        <div className="mb-1 flex items-center gap-2">
          <span
            className={`text-[11px] ${isUnread ? "font-semibold text-accent" : "text-text-tertiary"}`}
          >
            {attribution}
          </span>
          <span className="text-[10px] text-text-tertiary">
            {dateStr} {timeStr}
          </span>
          {isUnread && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
        </div>

        {/* Subject */}
        {email.subject && (
          <p
            className={`mb-1 text-xs ${isUnread ? "font-semibold" : "font-medium"} text-text-primary`}
          >
            {email.subject}
          </p>
        )}

        {/* Text body */}
        {displayText ? (
          <p className="whitespace-pre-wrap text-xs text-text-secondary leading-relaxed">
            {displayText}
          </p>
        ) : (
          <p className="text-xs text-text-tertiary italic">(no text content)</p>
        )}

        {/* Show more / less */}
        {text.length > TRUNCATE_LENGTH && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="mt-1 text-[11px] text-accent hover:underline"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}

        {/* Downloadable attachments */}
        {downloadableAttachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {downloadableAttachments.map((att) => (
              <a
                key={att.id}
                href={`/api/attachments/${att.id}`}
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 rounded border border-border-dark px-2 py-1 text-[10px] text-text-secondary hover:bg-hover"
              >
                <Paperclip size={10} />
                {att.filename}
              </a>
            ))}
          </div>
        )}

        {/* Expand icon (full HTML preview) */}
        {email.bodyHtml && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenHtml(email);
            }}
            className="absolute right-2 top-2 rounded p-1 text-text-tertiary opacity-0 transition-opacity hover:bg-hover hover:text-text-secondary group-hover:opacity-100"
            title="View full email"
          >
            <Maximize2 size={14} />
          </button>
        )}

        {/* Reply button for received emails */}
        {email.type === "received" && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReply(email.id);
            }}
            className="mt-2 text-[11px] text-text-tertiary hover:text-text-secondary"
          >
            Reply
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/MessageBubble.tsx
git commit -m "feat: add Slack-style message bubble component"
```

---

## Task 8: Rewrite SenderDetail as Conversation View

**Files:**

- Modify: `src/pages/SenderDetail.tsx`

- [ ] **Step 1: Replace the entire SenderDetail component**

```tsx
import { useState, useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  fetchSenderEmails,
  markEmailRead,
  fetchSenderEnrollment,
  type Sender,
  type Email,
  type SenderEnrollmentInfo,
} from "@/lib/api";
import EnrollSequenceModal from "@/components/EnrollSequenceModal";
import SequenceStatus from "@/components/SequenceStatus";
import MessageBubble from "@/components/MessageBubble";
import EmailHtmlModal from "@/components/EmailHtmlModal";

interface SenderDetailProps {
  sender: Sender;
  onReply: (emailId: string) => void;
}

export default function SenderDetail({ sender, onReply }: SenderDetailProps) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [enrollmentInfo, setEnrollmentInfo] =
    useState<SenderEnrollmentInfo | null>(null);
  const [htmlPreviewEmail, setHtmlPreviewEmail] = useState<Email | null>(null);
  const [recipientFilter, setRecipientFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Collect unique recipient addresses from emails
  const recipients = Array.from(
    new Set(
      emails
        .map((e) => (e.type === "received" ? e.recipient : e.toAddress))
        .filter(Boolean) as string[],
    ),
  );

  useEffect(() => {
    setLoading(true);
    setRecipientFilter("");
    fetchSenderEmails(sender.id)
      .then((data) => {
        setEmails(data);
      })
      .finally(() => setLoading(false));
  }, [sender.id]);

  useEffect(() => {
    fetchSenderEnrollment(sender.id).then(setEnrollmentInfo);
  }, [sender.id]);

  // Refetch when recipient filter changes
  useEffect(() => {
    if (!sender.id) return;
    setLoading(true);
    fetchSenderEmails(sender.id, {
      recipient: recipientFilter || undefined,
    })
      .then(setEmails)
      .finally(() => setLoading(false));
  }, [recipientFilter, sender.id]);

  function refreshEnrollment() {
    fetchSenderEnrollment(sender.id).then(setEnrollmentInfo);
  }

  async function handleMarkRead(email: Email) {
    if (email.type !== "received" || email.isRead !== 0) return;
    await markEmailRead(email.id, true);
    setEmails((prev) =>
      prev.map((e) => (e.id === email.id ? { ...e, isRead: 1 } : e)),
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        Loading...
      </div>
    );
  }

  // Reverse emails for chronological (oldest first) display
  const chronologicalEmails = [...emails].reverse();

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border-dark px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              {sender.name || sender.email}
            </h2>
            {sender.name && (
              <p className="text-xs text-text-secondary">{sender.email}</p>
            )}
            <p className="text-[11px] text-text-tertiary">
              {sender.totalCount} email{sender.totalCount !== 1 ? "s" : ""}
            </p>
          </div>
          {/* Recipient filter */}
          {recipients.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover">
                  {recipientFilter || "All addresses"}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="bg-card border-border-dark text-text-primary">
                <DropdownMenuItem
                  onClick={() => setRecipientFilter("")}
                  className="text-xs text-text-secondary focus:bg-hover focus:text-text-primary"
                >
                  All addresses
                </DropdownMenuItem>
                {recipients.map((r) => (
                  <DropdownMenuItem
                    key={r}
                    onClick={() => setRecipientFilter(r)}
                    className="text-xs text-text-secondary focus:bg-hover focus:text-text-primary"
                  >
                    {r}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Sequence status */}
      <div className="border-b border-border-dark px-6 py-2">
        {enrollmentInfo?.enrollment ? (
          <SequenceStatus
            senderId={sender.id}
            onStatusChange={refreshEnrollment}
          />
        ) : (
          <button
            onClick={() => setEnrollModalOpen(true)}
            className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover"
          >
            Add to Sequence
          </button>
        )}
      </div>

      {/* Conversation */}
      <ScrollArea className="flex-1">
        <div className="py-4" ref={scrollRef}>
          {chronologicalEmails.length === 0 ? (
            <p className="text-center text-xs text-text-tertiary">
              No emails found.
            </p>
          ) : (
            chronologicalEmails.map((email) => (
              <MessageBubble
                key={email.id}
                email={email}
                senderEmail={sender.email}
                onOpenHtml={setHtmlPreviewEmail}
                onMarkRead={handleMarkRead}
                onReply={onReply}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* HTML Preview Modal */}
      <EmailHtmlModal
        email={htmlPreviewEmail}
        open={htmlPreviewEmail !== null}
        onClose={() => setHtmlPreviewEmail(null)}
      />

      {/* Sequence Enrollment Modal */}
      <EnrollSequenceModal
        senderId={sender.id}
        senderName={sender.name}
        senderEmail={sender.email}
        open={enrollModalOpen}
        onClose={() => setEnrollModalOpen(false)}
        onEnrolled={refreshEnrollment}
      />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/SenderDetail.tsx
git commit -m "feat: rewrite sender detail as Slack-style conversation view"
```

---

## Task 9: Verify Build

- [ ] **Step 1: Run the build**

Run: `yarn build`

Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 2: Fix any build errors**

Common issues:

- The `Attachment` type in `api.ts` needs `contentId` field to match what `MessageBubble` checks
- The `like` import may be needed in `emails-router.ts` if not already imported
- Radix Dialog may need to be checked for the EmailHtmlModal

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build errors"
```
