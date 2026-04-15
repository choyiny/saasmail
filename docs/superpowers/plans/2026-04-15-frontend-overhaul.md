# Frontend Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign cmail with a dark blue-tinted theme, compact density, and persistent icon sidebar replacing per-page navigation.

**Architecture:** CSS custom properties define the dark theme. A `DashboardLayout` component wraps all authenticated routes and renders a three-column layout (icon sidebar | middle panel | content area). Each page strips its own header/nav and renders inside the layout. UI components are restyled via theme tokens.

**Tech Stack:** Tailwind CSS 4 (custom properties via `@theme`), React Router v6 (layout routes with `<Outlet>`), lucide-react (sidebar icons), existing Radix UI components.

---

### Task 1: Dark Theme CSS

**Files:**

- Modify: `src/index.css`

- [ ] **Step 1: Replace index.css with dark theme tokens**

Replace the entire content of `src/index.css` with:

```css
@import "tailwindcss";

@theme {
  --color-sidebar: #0f1117;
  --color-panel: #141720;
  --color-main: #1a1d2e;
  --color-hover: #2a2d3e;
  --color-card: #1e2235;
  --color-input-bg: #141720;
  --color-border-dark: #2a2d3e;
  --color-text-primary: #f0f0f0;
  --color-text-secondary: #8b8fa3;
  --color-text-tertiary: #5a5e70;
  --color-accent: #4f6ef7;
  --color-accent-hover: #6180f9;
  --color-destructive: #e5484d;
  --color-unread: #4f6ef7;
  --color-warning-bg: #2a2010;
  --color-warning-border: #5c4a1e;
  --color-warning-text: #f0c050;
}

html {
  font-size: 13px;
}

body {
  background-color: #1a1d2e;
  color: #f0f0f0;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/index.css
git commit -m "feat: add dark theme CSS custom properties"
```

---

### Task 2: Sidebar Component

**Files:**

- Create: `src/components/Sidebar.tsx`

- [ ] **Step 1: Create the Sidebar component**

Create `src/components/Sidebar.tsx`:

```tsx
import { useLocation, useNavigate } from "react-router-dom";
import { Mail, FileText, Key, Users, PenSquare, LogOut } from "lucide-react";
import { signOut, useSession } from "@/lib/auth-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NavItem {
  icon: React.ElementType;
  label: string;
  path: string;
  adminOnly?: boolean;
}

const navItems: NavItem[] = [
  { icon: Mail, label: "Inbox", path: "/" },
  { icon: FileText, label: "Templates", path: "/templates" },
  { icon: Key, label: "API", path: "/api-keys" },
  { icon: Users, label: "Users", path: "/admin/users", adminOnly: true },
];

function SidebarButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
        active
          ? "bg-hover text-text-primary"
          : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
      }`}
    >
      <Icon size={20} />
    </button>
  );
}

interface SidebarProps {
  onCompose: () => void;
}

export default function Sidebar({ onCompose }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session } = useSession();

  function isActive(path: string) {
    if (path === "/") {
      return location.pathname === "/" || location.pathname.startsWith("/?");
    }
    return location.pathname.startsWith(path);
  }

  return (
    <div className="flex h-full w-16 flex-col items-center bg-sidebar py-3">
      {/* Logo */}
      <div className="mb-4 flex h-10 w-10 items-center justify-center text-lg font-bold text-text-primary">
        c
      </div>

      {/* Nav items */}
      <nav className="flex flex-1 flex-col items-center gap-1">
        {navItems
          .filter((item) => !item.adminOnly || session?.user?.role === "admin")
          .map((item) => (
            <SidebarButton
              key={item.path}
              icon={item.icon}
              label={item.label}
              active={isActive(item.path)}
              onClick={() => navigate(item.path)}
            />
          ))}
      </nav>

      {/* Bottom actions */}
      <div className="flex flex-col items-center gap-1">
        <SidebarButton
          icon={PenSquare}
          label="Compose"
          active={false}
          onClick={onCompose}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title={session?.user?.email || "Account"}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
                {session?.user?.name?.[0]?.toUpperCase() || "?"}
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="end"
            className="bg-card border-border-dark text-text-primary"
          >
            <div className="px-2 py-1.5 text-xs text-text-secondary">
              {session?.user?.email}
            </div>
            <DropdownMenuItem
              onClick={() => signOut()}
              className="text-text-secondary focus:bg-hover focus:text-text-primary"
            >
              <LogOut size={14} />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: add icon sidebar component"
```

---

### Task 3: DashboardLayout + App.tsx Routing

**Files:**

- Create: `src/components/DashboardLayout.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create DashboardLayout**

Create `src/components/DashboardLayout.tsx`:

```tsx
import { useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import ComposeModal from "@/pages/ComposeModal";

export default function DashboardLayout() {
  const [composeOpen, setComposeOpen] = useState(false);

  return (
    <div className="flex h-screen bg-main">
      <Sidebar onCompose={() => setComposeOpen(true)} />
      <div className="flex flex-1 overflow-hidden">
        <Outlet />
      </div>
      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        replyToEmailId={null}
      />
    </div>
  );
}
```

- [ ] **Step 2: Rewrite App.tsx with layout routes**

Replace the entire content of `src/App.tsx`:

```tsx
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
} from "react-router-dom";
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
import ApiKeysPage from "@/pages/ApiKeysPage";
import DashboardLayout from "@/components/DashboardLayout";

const queryClient = new QueryClient();

function AuthGuard() {
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

  if (isPending || (session && passkeyStatus === null)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-main">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (!passkeyStatus) {
    return <Navigate to="/setup-passkey" replace />;
  }

  return <Outlet />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
          <Route path="/setup-passkey" element={<SetupPasskeyPage />} />

          {/* Authenticated routes with shared layout */}
          <Route element={<AuthGuard />}>
            <Route element={<DashboardLayout />}>
              <Route path="/admin/users" element={<AdminUsersPage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/templates/new" element={<TemplateEditorPage />} />
              <Route
                path="/templates/:slug/edit"
                element={<TemplateEditorPage />}
              />
              <Route path="/api-keys" element={<ApiKeysPage />} />
              <Route path="/*" element={<InboxPage />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
```

- [ ] **Step 3: Commit**

```bash
git add src/components/DashboardLayout.tsx src/App.tsx
git commit -m "feat: add DashboardLayout with sidebar and layout routes"
```

---

### Task 4: Restyle InboxPage

**Files:**

- Modify: `src/pages/InboxPage.tsx`

- [ ] **Step 1: Rewrite InboxPage to remove header and use dark theme**

Replace the entire content of `src/pages/InboxPage.tsx`:

```tsx
import { useState } from "react";
import SenderList from "./SenderList";
import SenderDetail from "./SenderDetail";
import ComposeModal from "./ComposeModal";
import type { Sender } from "@/lib/api";

export default function InboxPage() {
  const [selectedSender, setSelectedSender] = useState<Sender | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);

  function handleReply(emailId: string) {
    setReplyToEmailId(emailId);
    setComposeOpen(true);
  }

  return (
    <>
      {/* Middle panel — sender list */}
      <div className="w-80 shrink-0 border-r border-border-dark bg-panel">
        <SenderList
          selectedSenderId={selectedSender?.id ?? null}
          onSelectSender={setSelectedSender}
        />
      </div>

      {/* Right panel — email detail */}
      <div className="flex-1 bg-main">
        {selectedSender ? (
          <SenderDetail sender={selectedSender} onReply={handleReply} />
        ) : (
          <div className="flex h-full items-center justify-center text-text-tertiary">
            Select a sender to view emails
          </div>
        )}
      </div>

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        replyToEmailId={replyToEmailId}
      />
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/InboxPage.tsx
git commit -m "feat: restyle InboxPage for dark theme with sidebar layout"
```

---

### Task 5: Restyle SenderList

**Files:**

- Modify: `src/pages/SenderList.tsx`

- [ ] **Step 1: Rewrite SenderList with dark theme and compact density**

Replace the entire content of `src/pages/SenderList.tsx`:

```tsx
import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchSenders, fetchStats, type Sender } from "@/lib/api";

interface SenderListProps {
  selectedSenderId: string | null;
  onSelectSender: (sender: Sender) => void;
}

export default function SenderList({
  selectedSenderId,
  onSelectSender,
}: SenderListProps) {
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
    }, 200);
    return () => clearTimeout(timeout);
  }, [search, recipient]);

  function formatTime(ts: number) {
    const date = new Date(ts * 1000);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-3">
        <input
          type="text"
          placeholder="Search senders..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {recipients.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex h-7 w-full items-center justify-start rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-secondary hover:text-text-primary">
                {recipient || "All addresses"}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="bg-card border-border-dark text-text-primary">
              <DropdownMenuItem
                onClick={() => setRecipient("")}
                className="text-xs text-text-secondary focus:bg-hover focus:text-text-primary"
              >
                All addresses
              </DropdownMenuItem>
              {recipients.map((r) => (
                <DropdownMenuItem
                  key={r}
                  onClick={() => setRecipient(r)}
                  className="text-xs text-text-secondary focus:bg-hover focus:text-text-primary"
                >
                  {r}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <p className="p-4 text-center text-xs text-text-tertiary">
            Loading...
          </p>
        ) : senders.length === 0 ? (
          <p className="p-4 text-center text-xs text-text-tertiary">
            No senders found
          </p>
        ) : (
          senders.map((sender) => (
            <button
              key={sender.id}
              onClick={() => onSelectSender(sender)}
              className={`w-full border-b border-border-dark px-4 py-2.5 text-left transition-colors hover:bg-hover ${
                selectedSenderId === sender.id ? "bg-hover" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`truncate text-xs ${
                    sender.unreadCount > 0
                      ? "font-semibold text-text-primary"
                      : "text-text-secondary"
                  }`}
                >
                  {sender.name || sender.email}
                </span>
                <span className="ml-2 shrink-0 text-[11px] text-text-tertiary">
                  {formatTime(sender.lastEmailAt)}
                </span>
              </div>
              {sender.name && (
                <div className="truncate text-[11px] text-text-tertiary">
                  {sender.email}
                </div>
              )}
              <div className="mt-0.5 flex items-center justify-between">
                <span className="truncate text-[11px] text-text-tertiary">
                  {sender.latestSubject || "(no subject)"}
                </span>
                {sender.unreadCount > 0 && (
                  <span className="ml-2 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-unread px-1 text-[10px] font-semibold text-white">
                    {sender.unreadCount}
                  </span>
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

- [ ] **Step 2: Commit**

```bash
git add src/pages/SenderList.tsx
git commit -m "feat: restyle SenderList for dark theme with compact density"
```

---

### Task 6: Restyle SenderDetail

**Files:**

- Modify: `src/pages/SenderDetail.tsx`

- [ ] **Step 1: Rewrite SenderDetail with dark theme**

Replace the entire content of `src/pages/SenderDetail.tsx`:

```tsx
import { useState, useEffect } from "react";
import DOMPurify from "dompurify";
import { ScrollArea } from "@/components/ui/scroll-area";
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
    if (email.type === "received" && email.isRead === 0) {
      await markEmailRead(email.id, true);
      setEmails((prev) =>
        prev.map((e) => (e.id === email.id ? { ...e, isRead: 1 } : e)),
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
        em.id === email.id ? { ...em, isRead: newIsRead ? 1 : 0 } : em,
      ),
    );
  }

  function formatDate(ts: number) {
    return new Date(ts * 1000).toLocaleString();
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-dark px-6 py-3">
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

      <ScrollArea className="flex-1">
        {emails.map((email) => (
          <div key={email.id}>
            <button
              onClick={() => handleExpand(email)}
              className={`w-full px-6 py-2.5 text-left transition-colors hover:bg-hover ${
                expandedId === email.id ? "bg-hover" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                {email.type === "sent" && (
                  <span className="rounded border border-border-dark px-1.5 py-0.5 text-[10px] text-text-tertiary">
                    Sent
                  </span>
                )}
                <span
                  className={`flex-1 truncate text-xs ${
                    email.type === "received" && email.isRead === 0
                      ? "font-semibold text-text-primary"
                      : "text-text-secondary"
                  }`}
                >
                  {email.subject || "(no subject)"}
                </span>
                {email.type === "received" &&
                  (email.attachmentCount ?? 0) > 0 && (
                    <span className="text-[11px] text-text-tertiary">
                      {email.attachmentCount} file
                      {email.attachmentCount !== 1 ? "s" : ""}
                    </span>
                  )}
                <span className="shrink-0 text-[11px] text-text-tertiary">
                  {formatDate(email.timestamp)}
                </span>
              </div>
            </button>

            {expandedId === email.id && (
              <div className="border-t border-border-dark bg-card px-6 py-4">
                <div className="mb-3 flex items-center gap-2">
                  {email.type === "received" && (
                    <>
                      <button
                        onClick={() => onReply(email.id)}
                        className="rounded-md border border-border-dark px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                      >
                        Reply
                      </button>
                      <button
                        onClick={(e) => handleToggleRead(e, email)}
                        className="rounded-md px-3 py-1 text-xs text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary"
                      >
                        Mark {email.isRead ? "unread" : "read"}
                      </button>
                    </>
                  )}
                  {email.type === "sent" && email.toAddress && (
                    <span className="text-[11px] text-text-tertiary">
                      To: {email.toAddress}
                    </span>
                  )}
                  {email.type === "received" && email.recipient && (
                    <span className="text-[11px] text-text-tertiary">
                      To: {email.recipient}
                    </span>
                  )}
                </div>
                {email.bodyHtml ? (
                  <div
                    className="prose prose-sm prose-invert max-w-none text-text-secondary"
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(email.bodyHtml),
                    }}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap text-xs text-text-secondary">
                    {email.bodyText || "(empty)"}
                  </pre>
                )}
                {email.type === "received" &&
                  email.attachments &&
                  email.attachments.length > 0 && (
                    <div className="mt-4 border-t border-border-dark pt-3">
                      <p className="mb-2 text-[11px] font-medium text-text-tertiary">
                        Attachments
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {email.attachments.map((att) => (
                          <a
                            key={att.id}
                            href={`/api/attachments/${att.id}`}
                            className="rounded border border-border-dark px-3 py-1.5 text-[11px] text-text-secondary hover:bg-hover"
                          >
                            {att.filename} ({Math.round(att.size / 1024)}KB)
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            )}
            <div className="h-px bg-border-dark" />
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/SenderDetail.tsx
git commit -m "feat: restyle SenderDetail for dark theme"
```

---

### Task 7: Restyle ComposeModal

**Files:**

- Modify: `src/pages/ComposeModal.tsx`

- [ ] **Step 1: Rewrite ComposeModal with dark theme**

Replace the entire content of `src/pages/ComposeModal.tsx`:

```tsx
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
        await replyToEmail(replyToEmailId!, { bodyHtml });
      } else {
        await sendEmail({ to, subject, bodyHtml });
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
      <DialogContent className="border-border-dark bg-card text-text-primary sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-text-primary">
            {isReply ? "Reply" : "Compose"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSend} className="space-y-3">
          {!isReply && (
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
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Subject
            </label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required={!isReply}
              disabled={isReply}
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
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

- [ ] **Step 2: Commit**

```bash
git add src/pages/ComposeModal.tsx
git commit -m "feat: restyle ComposeModal for dark theme"
```

---

### Task 8: Restyle TiptapEditor

**Files:**

- Modify: `src/components/TiptapEditor.tsx`

- [ ] **Step 1: Rewrite TiptapEditor with dark theme**

Replace the entire content of `src/components/TiptapEditor.tsx`:

```tsx
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";

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
    <button
      type="button"
      className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
        active
          ? "bg-hover text-text-primary"
          : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function TiptapEditor({ content, onUpdate }: TiptapEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit],
    content,
    onUpdate: ({ editor }) => {
      onUpdate(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class:
          "prose prose-sm prose-invert max-w-none min-h-[200px] p-3 focus:outline-none text-text-primary",
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
    <div className="rounded-md border border-border-dark bg-input-bg">
      <div className="flex flex-wrap gap-0.5 border-b border-border-dark p-1">
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
          1.
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
git commit -m "feat: restyle TiptapEditor for dark theme"
```

---

### Task 9: Restyle TemplatesPage and TemplateEditorPage

**Files:**

- Modify: `src/pages/TemplatesPage.tsx`
- Modify: `src/pages/TemplateEditorPage.tsx`

- [ ] **Step 1: Rewrite TemplatesPage**

Replace the entire content of `src/pages/TemplatesPage.tsx`:

```tsx
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
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
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-sm font-semibold text-text-primary">
            Email Templates
          </h1>
          <button
            onClick={() => navigate("/templates/new")}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
          >
            New Template
          </button>
        </div>

        {loading ? (
          <p className="text-xs text-text-tertiary">Loading...</p>
        ) : templates.length === 0 ? (
          <p className="text-xs text-text-tertiary">No templates yet.</p>
        ) : (
          <div className="space-y-1">
            {templates.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-lg border border-border-dark bg-card px-4 py-3"
              >
                <div>
                  <p className="text-xs font-medium text-text-primary">
                    {t.name}
                  </p>
                  <p className="text-[11px] text-text-tertiary">
                    {t.slug} &middot; {t.subject}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => navigate(`/templates/${t.slug}/edit`)}
                    className="rounded-md px-2.5 py-1 text-[11px] text-text-secondary hover:bg-hover hover:text-text-primary"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(t.slug)}
                    className="rounded-md px-2.5 py-1 text-[11px] text-destructive hover:bg-hover"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite TemplateEditorPage**

Replace the entire content of `src/pages/TemplateEditorPage.tsx`:

```tsx
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
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
        await createTemplate({ slug: slugValue, name, subject, bodyHtml });
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
      <div className="flex-1 p-6">
        <p className="text-xs text-text-tertiary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <button
            onClick={() => navigate("/templates")}
            className="text-xs text-text-tertiary hover:text-text-secondary"
          >
            &larr; Templates
          </button>
          <h1 className="mt-2 text-sm font-semibold text-text-primary">
            {isEdit ? "Edit Template" : "New Template"}
          </h1>
        </div>

        <form onSubmit={handleSave} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Welcome Email"
              required
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Slug
            </label>
            <input
              value={slugValue}
              onChange={(e) => setSlugValue(e.target.value)}
              placeholder="welcome-email"
              pattern="[a-z0-9-]+"
              title="Lowercase letters, numbers, and hyphens only"
              disabled={isEdit}
              required
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Subject
            </label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Welcome, {{name}}!"
              required
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Body
            </label>
            <TiptapEditor content={bodyHtml} onUpdate={setBodyHtml} />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => navigate("/templates")}
              className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/pages/TemplatesPage.tsx src/pages/TemplateEditorPage.tsx
git commit -m "feat: restyle Templates pages for dark theme"
```

---

### Task 10: Restyle ApiKeysPage

**Files:**

- Modify: `src/pages/ApiKeysPage.tsx`

- [ ] **Step 1: Rewrite ApiKeysPage with dark theme**

Replace the entire content of `src/pages/ApiKeysPage.tsx`:

```tsx
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchApiKeyInfo, generateApiKey, revokeApiKey } from "@/lib/api";
import type { ApiKeyInfo } from "@/lib/api";

export default function ApiKeysPage() {
  const [keyInfo, setKeyInfo] = useState<ApiKeyInfo | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<
    "regenerate" | "revoke" | null
  >(null);

  useEffect(() => {
    fetchApiKeyInfo()
      .then((res) => setKeyInfo(res.key))
      .finally(() => setLoading(false));
  }, []);

  async function handleGenerate() {
    const res = await generateApiKey();
    setNewKey(res.key);
    setKeyInfo({ prefix: res.prefix, createdAt: res.createdAt });
    setConfirmAction(null);
  }

  async function handleRevoke() {
    await revokeApiKey();
    setKeyInfo(null);
    setNewKey(null);
    setConfirmAction(null);
  }

  function handleCopy() {
    if (newKey) navigator.clipboard.writeText(newKey);
  }

  if (loading) {
    return (
      <div className="flex-1 p-6">
        <p className="text-xs text-text-tertiary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-6 text-sm font-semibold text-text-primary">
          API Access
        </h1>

        {/* Newly generated key */}
        {newKey && (
          <div className="mb-6 rounded-lg border border-warning-border bg-warning-bg px-4 py-3">
            <p className="mb-2 text-xs font-medium text-warning-text">
              Your API key (copy it now — it won't be shown again):
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={newKey}
                className="h-8 flex-1 rounded-md border border-border-dark bg-input-bg px-3 font-mono text-xs text-text-primary focus:outline-none"
              />
              <button
                onClick={handleCopy}
                className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
              >
                Copy
              </button>
            </div>
            <button
              onClick={() => setNewKey(null)}
              className="mt-2 text-xs text-text-tertiary hover:text-text-secondary"
            >
              Done
            </button>
          </div>
        )}

        {/* Current key info */}
        {keyInfo && !newKey && (
          <div className="mb-6 rounded-lg border border-border-dark bg-card px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-mono text-xs text-text-primary">
                  {keyInfo.prefix}
                </p>
                <p className="text-[11px] text-text-tertiary">
                  Created{" "}
                  {new Date(keyInfo.createdAt * 1000).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmAction("regenerate")}
                  className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
                >
                  Regenerate
                </button>
                <button
                  onClick={() => setConfirmAction("revoke")}
                  className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-destructive hover:bg-hover"
                >
                  Revoke
                </button>
              </div>
            </div>
          </div>
        )}

        {/* No key */}
        {!keyInfo && !newKey && (
          <div className="mb-6 rounded-lg border border-border-dark bg-card px-4 py-4 text-center">
            <p className="mb-3 text-xs text-text-tertiary">
              No API key generated yet.
            </p>
            <button
              onClick={handleGenerate}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
            >
              Generate API Key
            </button>
          </div>
        )}

        {/* Usage */}
        <div className="rounded-lg border border-border-dark bg-card p-4">
          <h2 className="mb-2 text-xs font-semibold text-text-primary">
            Usage
          </h2>
          <p className="mb-2 text-xs text-text-secondary">
            Include your API key in the{" "}
            <code className="text-accent">Authorization</code> header:
          </p>
          <pre className="rounded bg-sidebar p-3 text-[11px] text-text-secondary">
            {`curl -H "Authorization: Bearer sk_..." \\
  https://your-domain/api/senders`}
          </pre>
          <p className="mt-2 text-xs text-text-secondary">
            The key grants full access to the API as your user account. See{" "}
            <a
              href="/swagger-ui"
              className="text-accent hover:text-accent-hover"
            >
              API docs
            </a>{" "}
            for available endpoints.
          </p>
        </div>

        {/* Confirmation dialog */}
        <Dialog
          open={confirmAction !== null}
          onOpenChange={() => setConfirmAction(null)}
        >
          <DialogContent className="border-border-dark bg-card text-text-primary">
            <DialogHeader>
              <DialogTitle className="text-text-primary">
                {confirmAction === "regenerate"
                  ? "Regenerate API Key?"
                  : "Revoke API Key?"}
              </DialogTitle>
            </DialogHeader>
            <p className="text-xs text-text-secondary">
              {confirmAction === "regenerate"
                ? "This will invalidate your current key and generate a new one. Any integrations using the old key will stop working."
                : "This will permanently delete your API key. Any integrations using it will stop working."}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmAction(null)}
                className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={
                  confirmAction === "regenerate" ? handleGenerate : handleRevoke
                }
                className={`rounded-md px-3 py-1.5 text-xs font-medium text-white ${
                  confirmAction === "revoke"
                    ? "bg-destructive hover:bg-destructive/90"
                    : "bg-accent hover:bg-accent-hover"
                }`}
              >
                {confirmAction === "regenerate" ? "Regenerate" : "Revoke"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/ApiKeysPage.tsx
git commit -m "feat: restyle ApiKeysPage for dark theme"
```

---

### Task 11: Restyle AdminUsersPage

**Files:**

- Modify: `src/pages/AdminUsersPage.tsx`

- [ ] **Step 1: Rewrite AdminUsersPage with dark theme**

Replace the entire content of `src/pages/AdminUsersPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "@/lib/auth-client";
import {
  fetchUsers,
  fetchInvites,
  createInvite,
  updateUserRole,
  deleteUser,
} from "@/lib/api";
import type { User, Invite } from "@/lib/api";
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
    if (session?.user?.role === "admin") loadData();
  }, [session]);

  if (session?.user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  async function handleCreateInvite() {
    setInviteLoading(true);
    try {
      const invite = await createInvite({
        role: inviteRole,
        email: inviteEmail || undefined,
        expiresInDays: parseInt(inviteExpiry) || 7,
      });
      setGeneratedLink(`${window.location.origin}/invite/${invite.token}`);
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
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Users */}
        <div className="rounded-lg border border-border-dark bg-card">
          <div className="flex items-center justify-between border-b border-border-dark px-4 py-3">
            <h2 className="text-xs font-semibold text-text-primary">Users</h2>
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
                <button className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover">
                  Invite User
                </button>
              </DialogTrigger>
              <DialogContent className="border-border-dark bg-card text-text-primary">
                <DialogHeader>
                  <DialogTitle className="text-text-primary">
                    Create Invitation
                  </DialogTitle>
                </DialogHeader>
                {!generatedLink ? (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-text-secondary">
                        Role
                      </label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setInviteRole("member")}
                          className={`rounded-md px-3 py-1.5 text-xs ${
                            inviteRole === "member"
                              ? "bg-accent text-white"
                              : "border border-border-dark text-text-secondary hover:bg-hover"
                          }`}
                        >
                          Member
                        </button>
                        <button
                          onClick={() => setInviteRole("admin")}
                          className={`rounded-md px-3 py-1.5 text-xs ${
                            inviteRole === "admin"
                              ? "bg-accent text-white"
                              : "border border-border-dark text-text-secondary hover:bg-hover"
                          }`}
                        >
                          Admin
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-text-secondary">
                        Email (optional)
                      </label>
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        placeholder="user@example.com"
                        className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-text-secondary">
                        Expires in (days)
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="30"
                        value={inviteExpiry}
                        onChange={(e) => setInviteExpiry(e.target.value)}
                        className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    </div>
                    <button
                      onClick={handleCreateInvite}
                      disabled={inviteLoading}
                      className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      {inviteLoading ? "Creating..." : "Create Invite"}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-text-secondary">
                      Share this link with the user:
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={generatedLink}
                        readOnly
                        className="h-8 flex-1 rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary focus:outline-none"
                      />
                      <button
                        onClick={handleCopy}
                        className="rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
                      >
                        {copied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </div>
          <div>
            {loading ? (
              <p className="p-4 text-xs text-text-tertiary">Loading...</p>
            ) : (
              users.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between border-b border-border-dark px-4 py-2.5 last:border-b-0"
                >
                  <div>
                    <p className="text-xs font-medium text-text-primary">
                      {user.name}
                    </p>
                    <p className="text-[11px] text-text-tertiary">
                      {user.email}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        user.hasPasskey
                          ? "bg-accent/20 text-accent"
                          : "bg-hover text-text-tertiary"
                      }`}
                    >
                      {user.hasPasskey ? "Passkey" : "No passkey"}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        user.role === "admin"
                          ? "bg-accent/20 text-accent"
                          : "border border-border-dark text-text-tertiary"
                      }`}
                    >
                      {user.role || "member"}
                    </span>
                    <span className="text-[10px] text-text-tertiary">
                      {formatDate(user.createdAt)}
                    </span>
                    {user.id !== session?.user?.id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="rounded px-1.5 py-0.5 text-xs text-text-tertiary hover:bg-hover hover:text-text-secondary">
                            ...
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="bg-card border-border-dark text-text-primary"
                        >
                          <DropdownMenuItem
                            onClick={() =>
                              handleRoleChange(
                                user.id,
                                user.role === "admin" ? "member" : "admin",
                              )
                            }
                            className="text-xs text-text-secondary focus:bg-hover focus:text-text-primary"
                          >
                            Make {user.role === "admin" ? "member" : "admin"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDelete(user.id)}
                            className="text-xs text-destructive focus:bg-hover"
                          >
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Invitations */}
        <div className="rounded-lg border border-border-dark bg-card">
          <div className="border-b border-border-dark px-4 py-3">
            <h2 className="text-xs font-semibold text-text-primary">
              Invitations
            </h2>
          </div>
          <div>
            {invites.length === 0 ? (
              <p className="p-4 text-xs text-text-tertiary">
                No invitations yet.
              </p>
            ) : (
              invites.map((invite) => {
                const st = inviteStatus(invite);
                return (
                  <div
                    key={invite.id}
                    className="flex items-center justify-between border-b border-border-dark px-4 py-2.5 last:border-b-0"
                  >
                    <div>
                      <p className="text-xs font-medium text-text-primary">
                        {invite.email || "Any email"}
                      </p>
                      <p className="text-[10px] text-text-tertiary">
                        Role: {invite.role} | Expires:{" "}
                        {formatDate(invite.expiresAt)}
                      </p>
                    </div>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        st === "used"
                          ? "bg-accent/20 text-accent"
                          : st === "expired"
                            ? "bg-hover text-text-tertiary"
                            : "border border-border-dark text-text-secondary"
                      }`}
                    >
                      {st}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/AdminUsersPage.tsx
git commit -m "feat: restyle AdminUsersPage for dark theme"
```

---

### Task 12: Restyle Unauthenticated Pages

**Files:**

- Modify: `src/pages/LoginPage.tsx`
- Modify: `src/pages/OnboardingPage.tsx`
- Modify: `src/pages/SetupPasskeyPage.tsx`
- Modify: `src/pages/InviteAcceptPage.tsx`

- [ ] **Step 1: Restyle LoginPage**

In `src/pages/LoginPage.tsx`, make these replacements:

Replace all `bg-neutral-50` with `bg-main`. Replace all `text-neutral-500` with `text-text-secondary`. Replace the `<Card className="w-full max-w-sm">` with `<Card className="w-full max-w-sm border-border-dark bg-card">`. Replace `<CardTitle className="text-2xl">` with `<CardTitle className="text-xl text-text-primary">`. Replace `text-red-500` with `text-destructive`. In the loading state divs, replace `text-neutral-500` with `text-text-secondary`.

The full file should become:

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
      <div className="flex min-h-screen items-center justify-center bg-main">
        <p className="text-text-secondary">Loading...</p>
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
    <div className="flex min-h-screen items-center justify-center bg-main">
      <Card className="w-full max-w-sm border-border-dark bg-card">
        <CardHeader>
          <CardTitle className="text-xl text-text-primary">cmail</CardTitle>
          <p className="text-xs text-text-secondary">
            Sign in with your passkey to continue.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-xs text-destructive">{error}</p>}
          <button
            className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            onClick={handlePasskeyLogin}
            disabled={loading}
          >
            {loading ? "Signing in..." : "Sign in with Passkey"}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Restyle OnboardingPage**

Replace the entire content of `src/pages/OnboardingPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signIn } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Status = "checking" | "available" | "unavailable";

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("checking");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup/status");
        const data = (await res.json()) as { setupRequired: boolean };
        if (cancelled) return;
        setStatus(data.setupRequired ? "available" : "unavailable");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || "Setup failed");
        if (res.status === 403) setStatus("unavailable");
        return;
      }
      const result = await signIn.emailAndPassword({ email, password });
      if (result.error) {
        navigate("/login", { replace: true });
        return;
      }
      window.location.href = "/setup-passkey";
    } catch {
      setError("Setup failed");
    } finally {
      setLoading(false);
    }
  }

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-main">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-main">
        <Card className="w-full max-w-sm border-border-dark bg-card">
          <CardHeader>
            <CardTitle className="text-xl text-text-primary">
              Setup complete
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-text-secondary">
              An administrator account already exists. Please sign in instead.
            </p>
            <button
              className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover"
              onClick={() => navigate("/login")}
            >
              Go to sign in
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const inputClass =
    "h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <div className="flex min-h-screen items-center justify-center bg-main">
      <Card className="w-full max-w-sm border-border-dark bg-card">
        <CardHeader>
          <CardTitle className="text-xl text-text-primary">
            Welcome to cmail
          </CardTitle>
          <p className="text-xs text-text-secondary">
            Create the first administrator account to get started.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className={inputClass}
              />
              <p className="text-[10px] text-text-tertiary">
                At least 8 characters.
              </p>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              disabled={loading}
            >
              {loading ? "Creating account..." : "Create administrator"}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Restyle SetupPasskeyPage**

Replace the entire content of `src/pages/SetupPasskeyPage.tsx`:

```tsx
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SetupPasskeyPage() {
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
    <div className="flex min-h-screen items-center justify-center bg-main">
      <Card className="w-full max-w-sm border-border-dark bg-card">
        <CardHeader>
          <CardTitle className="text-xl text-text-primary">
            Register a Passkey
          </CardTitle>
          <p className="text-xs text-text-secondary">
            For security, you must register a passkey before accessing cmail.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-xs text-destructive">{error}</p>}
          <button
            className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            onClick={handleRegister}
            disabled={loading}
          >
            {loading ? "Registering..." : "Register Passkey"}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Restyle InviteAcceptPage**

Replace the entire content of `src/pages/InviteAcceptPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { signIn } from "@/lib/auth-client";
import { validateInvite, acceptInvite } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
      <div className="flex min-h-screen items-center justify-center bg-main">
        <p className="text-text-secondary">Validating invitation...</p>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-main">
        <Card className="w-full max-w-sm border-border-dark bg-card">
          <CardHeader>
            <CardTitle className="text-xl text-text-primary">
              Invalid Invitation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-text-secondary">
              This invitation link is invalid, expired, or has already been
              used.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const inputClass =
    "h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <div className="flex min-h-screen items-center justify-center bg-main">
      <Card className="w-full max-w-sm border-border-dark bg-card">
        <CardHeader>
          <CardTitle className="text-xl text-text-primary">
            Join cmail
          </CardTitle>
          <p className="text-xs text-text-secondary">
            Create your account to get started.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                disabled={!!inviteEmail}
                className={inputClass + (inviteEmail ? " opacity-50" : "")}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className={inputClass}
              />
              <p className="text-[10px] text-text-tertiary">
                At least 8 characters.
              </p>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              disabled={loading}
            >
              {loading ? "Creating account..." : "Create account"}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/LoginPage.tsx src/pages/OnboardingPage.tsx src/pages/SetupPasskeyPage.tsx src/pages/InviteAcceptPage.tsx
git commit -m "feat: restyle unauthenticated pages for dark theme"
```

---

### Task 13: Verify and Fix Build

- [ ] **Step 1: Run TypeScript check**

```bash
npx tsc --noEmit
```

Fix any type errors.

- [ ] **Step 2: Run dev server and visually verify**

```bash
npx wrangler dev
```

Navigate through all pages:

1. `/login` — dark card on dark background
2. `/` (inbox) — sidebar + sender list + email detail, all dark
3. `/templates` — dark template list
4. `/templates/new` — dark editor
5. `/api-keys` — dark API keys page
6. `/admin/users` — dark admin page
7. Verify sidebar icons highlight correctly for each route
8. Verify compose modal opens from sidebar and works

- [ ] **Step 3: Commit any fixes**

```bash
git add -u
git commit -m "fix: resolve build and styling issues from dark theme overhaul"
```
