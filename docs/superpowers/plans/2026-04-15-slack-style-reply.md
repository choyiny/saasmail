# Slack-Style Reply Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the reply modal with a bottom-docked inline reply composer in the conversation view, with template reply and from-address selection support.

**Architecture:** The reply composer becomes a local component inside `SenderDetail`, removing the modal flow. The backend reply endpoint is extended with optional `fromAddress`, `templateSlug`, and `variables` fields. The frontend API client is updated to match.

**Tech Stack:** React, TypeScript, TiptapEditor, Hono (backend), Drizzle ORM, Zod

---

## File Map

| Action | File                                | Responsibility                                             |
| ------ | ----------------------------------- | ---------------------------------------------------------- |
| Create | `src/components/ReplyComposer.tsx`  | Bottom-docked reply composer with freeform/template tabs   |
| Modify | `src/pages/SenderDetail.tsx`        | Own reply state locally, render ReplyComposer              |
| Modify | `src/pages/InboxPage.tsx`           | Remove reply state, simplify ComposeModal usage            |
| Modify | `src/pages/ComposeModal.tsx`        | Remove reply mode, compose-only                            |
| Modify | `src/lib/api.ts`                    | Extend `replyToEmail` signature                            |
| Modify | `worker/src/routers/send-router.ts` | Accept `fromAddress`, `templateSlug`, `variables` on reply |

---

### Task 1: Extend the backend reply endpoint

**Files:**

- Modify: `worker/src/routers/send-router.ts:107-205`

- [ ] **Step 1: Update the request schema for the reply route**

In `worker/src/routers/send-router.ts`, change the reply route's request body schema from:

```typescript
schema: z.object({
  bodyHtml: z.string(),
  bodyText: z.string().optional(),
}),
```

to:

```typescript
schema: z.object({
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
  fromAddress: z.string().email().optional(),
  templateSlug: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
}),
```

- [ ] **Step 2: Update the handler to support template and fromAddress**

Add imports at the top of `worker/src/routers/send-router.ts`:

```typescript
import { emailTemplates } from "../db/email-templates.schema";
import { interpolate, extractVariables } from "../lib/interpolate";
```

Replace the handler body of `sendRouter.openapi(replyEmailRoute, ...)` (lines 130-205) with:

```typescript
sendRouter.openapi(replyEmailRoute, async (c) => {
  const db = c.get("db");
  const { emailId } = c.req.valid("param");
  const {
    bodyHtml,
    bodyText,
    fromAddress: requestedFrom,
    templateSlug,
    variables,
  } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

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

  // Determine from address
  let finalFrom = c.env.RESEND_EMAIL_FROM;
  if (requestedFrom) {
    finalFrom = requestedFrom;
  }

  // Determine subject and body
  let finalSubject: string;
  let finalBodyHtml: string;

  if (templateSlug) {
    // Template-based reply
    const templateRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, templateSlug))
      .limit(1);

    if (templateRows.length === 0) {
      return c.json({ error: "Template not found" }, 404);
    }

    const template = templateRows[0];
    const vars = variables ?? {};

    // Validate required variables
    const subjectVars = extractVariables(template.subject);
    const bodyVars = extractVariables(template.bodyHtml);
    const requiredVars = Array.from(new Set([...subjectVars, ...bodyVars]));
    const missingVars = requiredVars.filter((v) => !(v in vars));

    if (missingVars.length > 0) {
      return c.json(
        {
          error: "Missing required template variables",
          missingVariables: missingVars,
          requiredVariables: requiredVars,
        },
        400,
      );
    }

    finalSubject = interpolate(template.subject, vars);
    finalBodyHtml = interpolate(template.bodyHtml, vars);
  } else if (bodyHtml) {
    // Freeform reply
    finalSubject = orig.subject?.startsWith("Re: ")
      ? orig.subject
      : `Re: ${orig.subject || ""}`;
    finalBodyHtml = bodyHtml;
  } else {
    return c.json(
      { error: "Either bodyHtml or templateSlug is required" },
      400,
    );
  }

  // Send via Resend
  const resend = new Resend(c.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: finalFrom,
    to: toAddress,
    subject: finalSubject,
    html: finalBodyHtml,
    text: bodyText,
    headers: orig.messageId ? { "In-Reply-To": orig.messageId } : undefined,
  });

  // Store sent email
  const id = nanoid();
  await db.insert(sentEmails).values({
    id,
    senderId: orig.senderId,
    fromAddress: finalFrom,
    toAddress,
    subject: finalSubject,
    bodyHtml: finalBodyHtml,
    bodyText: bodyText ?? null,
    inReplyTo: orig.messageId,
    resendId: result.data?.id ?? null,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  // Cancel any active sequences for this sender
  await cancelSequencesForSender(db, orig.senderId);

  return c.json(
    {
      id,
      resendId: result.data?.id ?? null,
      status: result.error ? "failed" : "sent",
    },
    201,
  );
});
```

- [ ] **Step 3: Verify the worker compiles**

Run: `cd worker && npx wrangler deploy --dry-run`
Expected: No TypeScript errors, dry-run succeeds.

- [ ] **Step 4: Commit**

```bash
git add worker/src/routers/send-router.ts
git commit -m "feat: extend reply endpoint with fromAddress, templateSlug, variables"
```

---

### Task 2: Extend the frontend API client

**Files:**

- Modify: `src/lib/api.ts:112-121`

- [ ] **Step 1: Update the `replyToEmail` function signature**

In `src/lib/api.ts`, replace the `replyToEmail` function with:

```typescript
export async function replyToEmail(
  emailId: string,
  data: {
    bodyHtml?: string;
    bodyText?: string;
    fromAddress?: string;
    templateSlug?: string;
    variables?: Record<string, string>;
  },
): Promise<{ id: string }> {
  return apiFetch(`/api/send/reply/${emailId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: extend replyToEmail API with fromAddress and template params"
```

---

### Task 3: Create the ReplyComposer component

**Files:**

- Create: `src/components/ReplyComposer.tsx`

- [ ] **Step 1: Create the ReplyComposer component**

Create `src/components/ReplyComposer.tsx` with this content:

```tsx
import { useState, useEffect, useMemo } from "react";
import { X } from "lucide-react";
import TiptapEditor from "@/components/TiptapEditor";
import { replyToEmail, fetchTemplates, type EmailTemplate } from "@/lib/api";

interface ReplyComposerProps {
  emailId: string;
  senderName: string | null;
  senderEmail: string;
  recipients: string[];
  onClose: () => void;
  onSent: () => void;
}

type Tab = "freeform" | "template";

function extractVariables(subject: string, bodyHtml: string): string[] {
  const vars = new Set<string>();
  const regex = /\{\{(\w+)\}\}/g;
  for (const src of [subject, bodyHtml]) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(src)) !== null) {
      vars.add(m[1]);
    }
  }
  return Array.from(vars);
}

export default function ReplyComposer({
  emailId,
  senderName,
  senderEmail,
  recipients,
  onClose,
  onSent,
}: ReplyComposerProps) {
  const [tab, setTab] = useState<Tab>("freeform");
  const [fromAddress, setFromAddress] = useState(recipients[0] ?? "");
  const [bodyHtml, setBodyHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  // Template state
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState("");

  const selectedTemplate =
    templates.find((t) => t.slug === selectedSlug) ?? null;

  const requiredVars = useMemo(() => {
    if (!selectedTemplate) return [];
    return extractVariables(
      selectedTemplate.subject,
      selectedTemplate.bodyHtml,
    );
  }, [selectedTemplate]);

  // Auto-fill variables when template or sender changes
  useEffect(() => {
    if (!selectedTemplate) return;
    const vars: Record<string, string> = {};
    for (const v of requiredVars) {
      if (v.toLowerCase() === "name" && senderName) {
        vars[v] = senderName;
      } else if (v.toLowerCase() === "email") {
        vars[v] = senderEmail;
      } else {
        vars[v] = templateVars[v] ?? "";
      }
    }
    setTemplateVars(vars);
  }, [selectedSlug, requiredVars.join(",")]);

  // Fetch templates when switching to template tab
  useEffect(() => {
    if (tab !== "template" || templates.length > 0) return;
    setTemplatesLoading(true);
    setTemplatesError("");
    fetchTemplates()
      .then(setTemplates)
      .catch(() => setTemplatesError("Failed to load templates"))
      .finally(() => setTemplatesLoading(false));
  }, [tab]);

  async function handleSend() {
    setSending(true);
    setError("");
    try {
      if (tab === "freeform") {
        await replyToEmail(emailId, { bodyHtml, fromAddress });
      } else {
        if (!selectedSlug) {
          setError("Select a template");
          setSending(false);
          return;
        }
        await replyToEmail(emailId, {
          templateSlug: selectedSlug,
          variables: templateVars,
          fromAddress,
        });
      }
      onSent();
      onClose();
    } catch {
      setError("Failed to send reply");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border-t border-border-dark bg-panel shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-dark">
        <span className="text-xs font-semibold text-text-primary">Reply</span>
        <button
          onClick={onClose}
          className="text-text-tertiary hover:text-text-secondary"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-2 space-y-2">
        {/* From picker */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-tertiary shrink-0">From</label>
          <select
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            className="flex-1 bg-transparent border border-border-dark rounded-md px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {recipients.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {/* Tab toggle */}
        <div className="flex gap-1">
          <button
            onClick={() => setTab("freeform")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              tab === "freeform"
                ? "bg-accent text-white"
                : "text-text-secondary hover:bg-hover"
            }`}
          >
            Freeform
          </button>
          <button
            onClick={() => setTab("template")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              tab === "template"
                ? "bg-accent text-white"
                : "text-text-secondary hover:bg-hover"
            }`}
          >
            Template
          </button>
        </div>

        {/* Content area */}
        {tab === "freeform" ? (
          <TiptapEditor
            content={bodyHtml}
            onUpdate={setBodyHtml}
            placeholder="Write your reply..."
          />
        ) : (
          <div className="space-y-2">
            {templatesLoading ? (
              <p className="text-xs text-text-tertiary">Loading templates...</p>
            ) : templatesError ? (
              <p className="text-xs text-destructive">{templatesError}</p>
            ) : (
              <>
                <select
                  value={selectedSlug}
                  onChange={(e) => setSelectedSlug(e.target.value)}
                  className="w-full bg-transparent border border-border-dark rounded-md px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="">Select a template...</option>
                  {templates.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.name}
                    </option>
                  ))}
                </select>

                {selectedTemplate && (
                  <>
                    {/* Subject preview */}
                    <div className="text-xs text-text-secondary">
                      <span className="text-text-tertiary">Subject: </span>
                      {selectedTemplate.subject}
                    </div>

                    {/* Body preview */}
                    <div
                      className="rounded-md border border-border-dark bg-main p-3 text-xs text-text-secondary max-h-32 overflow-auto"
                      dangerouslySetInnerHTML={{
                        __html: selectedTemplate.bodyHtml,
                      }}
                    />

                    {/* Variable inputs */}
                    {requiredVars.length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-[10px] text-text-tertiary uppercase tracking-wider">
                          Variables
                        </span>
                        {requiredVars.map((v) => (
                          <div key={v} className="flex items-center gap-2">
                            <label className="text-xs text-text-tertiary font-mono shrink-0 w-20 truncate">
                              {`{{${v}}}`}
                            </label>
                            <input
                              value={templateVars[v] ?? ""}
                              onChange={(e) =>
                                setTemplateVars((prev) => ({
                                  ...prev,
                                  [v]: e.target.value,
                                }))
                              }
                              className="flex-1 bg-transparent border border-border-dark rounded-md px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-1">
          {error && <span className="text-xs text-destructive">{error}</span>}
          <div className="ml-auto">
            <button
              onClick={handleSend}
              disabled={sending}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
            >
              {sending ? "Sending..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend compiles**

Run: `cd /Users/choyiny/workspace/cmail && npx tsc --noEmit`
Expected: No errors (or only pre-existing ones).

- [ ] **Step 3: Commit**

```bash
git add src/components/ReplyComposer.tsx
git commit -m "feat: add ReplyComposer component with freeform and template tabs"
```

---

### Task 4: Update SenderDetail to own reply state and render ReplyComposer

**Files:**

- Modify: `src/pages/SenderDetail.tsx`

- [ ] **Step 1: Update imports and props**

In `src/pages/SenderDetail.tsx`, add the `ReplyComposer` import and update the props interface.

Replace the import block and interface:

```typescript
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
```

with:

```typescript
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
import ReplyComposer from "@/components/ReplyComposer";

interface SenderDetailProps {
  sender: Sender;
}
```

- [ ] **Step 2: Update the component function signature and add reply state**

Replace:

```typescript
export default function SenderDetail({ sender, onReply }: SenderDetailProps) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [enrollmentInfo, setEnrollmentInfo] =
    useState<SenderEnrollmentInfo | null>(null);
  const [htmlPreviewEmail, setHtmlPreviewEmail] = useState<Email | null>(null);
  const [recipientFilter, setRecipientFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
```

with:

```typescript
export default function SenderDetail({ sender }: SenderDetailProps) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [enrollmentInfo, setEnrollmentInfo] =
    useState<SenderEnrollmentInfo | null>(null);
  const [htmlPreviewEmail, setHtmlPreviewEmail] = useState<Email | null>(null);
  const [recipientFilter, setRecipientFilter] = useState("");
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 3: Add a refetch helper and reset reply on sender change**

Add after the existing `useEffect` for fetching emails on `sender.id` change (line 46-54), inside the same effect's `.then()`:

Replace:

```typescript
useEffect(() => {
  setLoading(true);
  setRecipientFilter("");
  fetchSenderEmails(sender.id)
    .then((data) => {
      setEmails(data);
    })
    .finally(() => setLoading(false));
}, [sender.id]);
```

with:

```typescript
function refetchEmails() {
  fetchSenderEmails(sender.id, {
    recipient: recipientFilter || undefined,
  }).then(setEmails);
}

useEffect(() => {
  setLoading(true);
  setRecipientFilter("");
  setReplyToEmailId(null);
  fetchSenderEmails(sender.id)
    .then((data) => {
      setEmails(data);
    })
    .finally(() => setLoading(false));
}, [sender.id]);
```

- [ ] **Step 4: Update the MessageBubble onReply and add ReplyComposer to render**

Replace the `onReply` prop on `MessageBubble` and add the `ReplyComposer` below `ScrollArea`.

Replace the entire return block (from `return (` to the closing `);`):

```tsx
return (
  <div className="flex h-full flex-col">
    {/* Header */}
    <div className="border-b border-border-dark px-4 sm:px-6 py-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
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
    <div className="border-b border-border-dark px-4 sm:px-6 py-2">
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
    <ScrollArea className="flex-1 min-h-0">
      <div className="divide-y divide-border-dark" ref={scrollRef}>
        {chronologicalEmails.length === 0 ? (
          <p className="py-4 text-center text-xs text-text-tertiary">
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
              onReply={setReplyToEmailId}
            />
          ))
        )}
      </div>
    </ScrollArea>

    {/* Reply Composer */}
    {replyToEmailId && (
      <ReplyComposer
        emailId={replyToEmailId}
        senderName={sender.name}
        senderEmail={sender.email}
        recipients={recipients}
        onClose={() => setReplyToEmailId(null)}
        onSent={refetchEmails}
      />
    )}

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
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/SenderDetail.tsx
git commit -m "feat: move reply state into SenderDetail, render ReplyComposer"
```

---

### Task 5: Simplify InboxPage and ComposeModal (remove reply mode)

**Files:**

- Modify: `src/pages/InboxPage.tsx`
- Modify: `src/pages/ComposeModal.tsx`

- [ ] **Step 1: Simplify InboxPage**

Replace the entire content of `src/pages/InboxPage.tsx` with:

```tsx
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import SenderList from "./SenderList";
import SenderDetail from "./SenderDetail";
import ComposeModal from "./ComposeModal";
import type { Sender } from "@/lib/api";

export default function InboxPage() {
  const [selectedSender, setSelectedSender] = useState<Sender | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  return (
    <>
      {/* Middle panel — sender list (hidden on mobile when a sender is selected) */}
      <div
        className={`w-full md:w-80 shrink-0 border-r border-border-dark bg-panel ${
          selectedSender ? "hidden md:block" : "block"
        }`}
      >
        <SenderList
          selectedSenderId={selectedSender?.id ?? null}
          onSelectSender={setSelectedSender}
        />
      </div>

      {/* Right panel — email detail (hidden on mobile when no sender selected) */}
      <div
        className={`flex-1 bg-main min-w-0 ${
          selectedSender ? "block" : "hidden md:block"
        }`}
      >
        {selectedSender ? (
          <div className="flex h-full flex-col">
            {/* Mobile back button */}
            <button
              onClick={() => setSelectedSender(null)}
              className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-secondary hover:text-text-primary md:hidden border-b border-border-dark"
            >
              <ArrowLeft size={14} />
              Back
            </button>
            <div className="flex-1 overflow-hidden">
              <SenderDetail sender={selectedSender} />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-text-tertiary">
            Select a sender to view emails
          </div>
        )}
      </div>

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />
    </>
  );
}
```

- [ ] **Step 2: Simplify ComposeModal to compose-only**

Replace the entire content of `src/pages/ComposeModal.tsx` with:

```tsx
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import TiptapEditor from "@/components/TiptapEditor";
import { sendEmail } from "@/lib/api";

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ComposeModal({ open, onClose }: ComposeModalProps) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setTo("");
      setSubject("");
      setBodyHtml("");
      setError("");
    }
  }, [open]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError("");
    try {
      await sendEmail({ to, subject, bodyHtml });
      onClose();
    } catch {
      setError("Failed to send email");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="border-border-dark bg-card text-text-primary sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-text-primary">Compose</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSend} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              To
            </label>
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Subject
            </label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Message
            </label>
            <TiptapEditor content={bodyHtml} onUpdate={setBodyHtml} />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={sending}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {sending ? "Sending..." : "Send"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Verify frontend compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/InboxPage.tsx src/pages/ComposeModal.tsx
git commit -m "refactor: remove reply mode from ComposeModal and InboxPage"
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Start the dev server and verify the full flow**

Run: `npm run dev` (or equivalent)

Manual checks:

1. Open inbox, select a sender with received emails
2. Click "Reply" on a received email — bottom composer appears (not a modal)
3. Verify "From" dropdown shows available recipient addresses
4. Type a freeform reply and click Send — email sends, composer closes, email list refreshes
5. Click Reply again, switch to "Template" tab — templates load in dropdown
6. Select a template — preview renders, variable inputs appear with auto-filled values
7. Click Send with template — email sends successfully
8. Click the X button — composer dismisses
9. Open the compose button from sidebar — modal still works for new emails
10. Switch between senders — reply composer closes

- [ ] **Step 2: Commit any fixes if needed**
