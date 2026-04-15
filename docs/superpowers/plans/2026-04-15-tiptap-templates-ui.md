# Tiptap Editor & Templates UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared Tiptap rich text editor, a templates management UI (list page + editor page), and replace the compose modal's textarea with Tiptap.

**Architecture:** A reusable `TiptapEditor` component wraps `@tiptap/react` with StarterKit. New pages for template list and editor are added at `/templates` routes. The compose modal swaps its textarea for the shared editor. API client gets template CRUD functions.

**Tech Stack:** React, @tiptap/react, @tiptap/starter-kit, @tiptap/pm, React Router, TanStack React Query

---

## File Structure

| File                               | Action | Responsibility                          |
| ---------------------------------- | ------ | --------------------------------------- |
| `src/components/TiptapEditor.tsx`  | Create | Shared Tiptap editor with toolbar       |
| `src/lib/api.ts`                   | Modify | Add EmailTemplate type + CRUD functions |
| `src/pages/TemplatesPage.tsx`      | Create | Template list with create/delete        |
| `src/pages/TemplateEditorPage.tsx` | Create | Full-page template editor (create/edit) |
| `src/pages/ComposeModal.tsx`       | Modify | Replace Textarea with TiptapEditor      |
| `src/pages/InboxPage.tsx`          | Modify | Add Templates link to header            |
| `src/App.tsx`                      | Modify | Add /templates routes                   |

---

### Task 1: Install Tiptap Dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install tiptap packages**

Run:

```bash
npm install @tiptap/react @tiptap/starter-kit @tiptap/pm
```

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add tiptap dependencies"
```

---

### Task 2: TiptapEditor Component

**Files:**

- Create: `src/components/TiptapEditor.tsx`

- [ ] **Step 1: Create the TiptapEditor component**

Create `src/components/TiptapEditor.tsx`:

```tsx
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

interface TiptapEditorProps {
  content: string;
  onUpdate: (html: string) => void;
  placeholder?: string;
}

function ToolbarButton({
  onClick,
  active,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export default function TiptapEditor({
  content,
  onUpdate,
  placeholder,
}: TiptapEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit],
    content,
    onUpdate: ({ editor }) => {
      onUpdate(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none min-h-[200px] p-3 focus:outline-none",
      },
    },
  });

  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content);
    }
  }, [content]);

  if (!editor) return null;

  return (
    <div className="rounded-md border border-neutral-200">
      <div className="flex flex-wrap gap-1 border-b border-neutral-200 p-1">
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive("bold")}
        >
          B
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive("italic")}
        >
          I
        </ToolbarButton>
        <ToolbarButton
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
          active={editor.isActive("heading", { level: 2 })}
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
          active={editor.isActive("heading", { level: 3 })}
        >
          H3
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive("bulletList")}
        >
          List
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive("orderedList")}
        >
          1. List
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          active={editor.isActive("blockquote")}
        >
          Quote
        </ToolbarButton>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/TiptapEditor.tsx
git commit -m "feat: add shared TiptapEditor component"
```

---

### Task 3: API Client — Template CRUD Functions

**Files:**

- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add template types and API functions**

Append the following to the end of `src/lib/api.ts`:

```ts
export interface EmailTemplate {
  id: string;
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  createdAt: number;
  updatedAt: number;
}

export async function fetchTemplates(): Promise<EmailTemplate[]> {
  return apiFetch("/api/email-templates");
}

export async function fetchTemplate(slug: string): Promise<EmailTemplate> {
  return apiFetch(`/api/email-templates/${slug}`);
}

export async function createTemplate(data: {
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
}): Promise<EmailTemplate> {
  return apiFetch("/api/email-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateTemplate(
  slug: string,
  data: { name?: string; subject?: string; bodyHtml?: string },
): Promise<EmailTemplate> {
  return apiFetch(`/api/email-templates/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteTemplate(
  slug: string,
): Promise<{ success: boolean }> {
  return apiFetch(`/api/email-templates/${slug}`, {
    method: "DELETE",
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: add email template API client functions"
```

---

### Task 4: Templates List Page

**Files:**

- Create: `src/pages/TemplatesPage.tsx`

- [ ] **Step 1: Create the templates list page**

Create `src/pages/TemplatesPage.tsx`:

```tsx
import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchTemplates, deleteTemplate } from "@/lib/api";
import type { EmailTemplate } from "@/lib/api";

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchTemplates()
      .then(setTemplates)
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(slug: string) {
    if (!confirm("Delete this template?")) return;
    await deleteTemplate(slug);
    setTemplates((prev) => prev.filter((t) => t.slug !== slug));
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            to="/"
            className="text-sm text-neutral-500 hover:text-neutral-700"
          >
            &larr; Inbox
          </Link>
          <h1 className="text-lg font-semibold">Email Templates</h1>
        </div>
        <Button size="sm" onClick={() => navigate("/templates/new")}>
          New Template
        </Button>
      </div>

      {loading ? (
        <p className="text-neutral-500">Loading...</p>
      ) : templates.length === 0 ? (
        <p className="text-neutral-500">No templates yet.</p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <Card key={t.id}>
              <CardContent className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">{t.name}</p>
                  <p className="text-sm text-neutral-500">
                    {t.slug} &middot; {t.subject}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/templates/${t.slug}/edit`)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:text-red-700"
                    onClick={() => handleDelete(t.slug)}
                  >
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/TemplatesPage.tsx
git commit -m "feat: add templates list page"
```

---

### Task 5: Template Editor Page

**Files:**

- Create: `src/pages/TemplateEditorPage.tsx`

- [ ] **Step 1: Create the template editor page**

Create `src/pages/TemplateEditorPage.tsx`:

```tsx
import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import TiptapEditor from "@/components/TiptapEditor";
import { fetchTemplate, createTemplate, updateTemplate } from "@/lib/api";

export default function TemplateEditorPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(slug);

  const [name, setName] = useState("");
  const [slugValue, setSlugValue] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(isEdit);

  useEffect(() => {
    if (slug) {
      fetchTemplate(slug)
        .then((t) => {
          setName(t.name);
          setSlugValue(t.slug);
          setSubject(t.subject);
          setBodyHtml(t.bodyHtml);
        })
        .catch(() => setError("Template not found"))
        .finally(() => setLoading(false));
    }
  }, [slug]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (isEdit) {
        await updateTemplate(slug!, { name, subject, bodyHtml });
      } else {
        await createTemplate({
          slug: slugValue,
          name,
          subject,
          bodyHtml,
        });
      }
      navigate("/templates");
    } catch {
      setError("Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6">
        <Link
          to="/templates"
          className="text-sm text-neutral-500 hover:text-neutral-700"
        >
          &larr; Templates
        </Link>
        <h1 className="mt-2 text-lg font-semibold">
          {isEdit ? "Edit Template" : "New Template"}
        </h1>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Welcome Email"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            value={slugValue}
            onChange={(e) => setSlugValue(e.target.value)}
            placeholder="welcome-email"
            pattern="[a-z0-9-]+"
            title="Lowercase letters, numbers, and hyphens only"
            disabled={isEdit}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="subject">Subject</Label>
          <Input
            id="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Welcome, {{name}}!"
            required
          />
        </div>

        <div className="space-y-2">
          <Label>Body</Label>
          <TiptapEditor content={bodyHtml} onUpdate={setBodyHtml} />
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate("/templates")}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/TemplateEditorPage.tsx
git commit -m "feat: add template editor page"
```

---

### Task 6: Update ComposeModal to Use TiptapEditor

**Files:**

- Modify: `src/pages/ComposeModal.tsx`

- [ ] **Step 1: Replace Textarea with TiptapEditor**

Replace the full contents of `src/pages/ComposeModal.tsx` with:

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
import TiptapEditor from "@/components/TiptapEditor";
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
  const [bodyHtml, setBodyHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const isReply = replyToEmailId !== null;

  useEffect(() => {
    if (!open) {
      setTo("");
      setSubject("");
      setBodyHtml("");
      setError("");
      return;
    }
    if (replyToEmailId) {
      fetchEmail(replyToEmailId).then((email) => {
        setSubject(
          email.subject?.startsWith("Re: ")
            ? email.subject
            : `Re: ${email.subject || ""}`,
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
          bodyHtml,
        });
      } else {
        await sendEmail({
          to,
          subject,
          bodyHtml,
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
            <Label>Message</Label>
            <TiptapEditor content={bodyHtml} onUpdate={setBodyHtml} />
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
git add src/pages/ComposeModal.tsx
git commit -m "feat: replace compose textarea with TiptapEditor"
```

---

### Task 7: Add Routes and Navigation

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/pages/InboxPage.tsx`

- [ ] **Step 1: Add template routes to App.tsx**

Replace the full contents of `src/App.tsx` with:

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import LoginPage from "@/pages/LoginPage";
import OnboardingPage from "@/pages/OnboardingPage";
import InboxPage from "@/pages/InboxPage";
import TemplatesPage from "@/pages/TemplatesPage";
import TemplateEditorPage from "@/pages/TemplateEditorPage";

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
          <Route path="/onboarding" element={<OnboardingPage />} />
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

- [ ] **Step 2: Add Templates link to InboxPage header**

In `src/pages/InboxPage.tsx`, add a `Link` import and a Templates link in the header. Add this import at the top:

```tsx
import { Link } from "react-router-dom";
```

Then in the header's button group (the `div` with `className="flex items-center gap-2"`), add the Templates link before the Compose button:

```tsx
<Link
  to="/templates"
  className="text-sm text-neutral-500 hover:text-neutral-700"
>
  Templates
</Link>
```

- [ ] **Step 3: Verify build**

Run:

```bash
npx wrangler deploy --dry-run
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/pages/InboxPage.tsx
git commit -m "feat: add template routes and navigation link"
```
