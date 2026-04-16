# cmail Light-Theme Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace cmail's dark theme with a modern light theme across all 30+ frontend files, introduce a collapsible sidebar, and unify the component primitives against a single blue-accent token system — no feature changes.

**Architecture:** Tailwind v4 `@theme` defines the new token palette in `src/index.css`. Shadcn UI primitives (`src/components/ui/*`) are rewritten to consume those tokens. Consumer components and pages are rethemed via class substitution (old dark tokens → new light tokens). A new `useSidebarCollapsed` hook persists sidebar state to localStorage.

**Tech Stack:** React 18, Tailwind v4, Radix UI, CodeMirror 6, TipTap 3, lucide-react, shadcn/ui patterns.

**Spec:** `docs/superpowers/specs/2026-04-16-light-theme-redesign-design.md`

---

## Token Mapping Reference

Use this table for class substitutions during retheme tasks. When you see the "Before" class in a file, replace with the "After" class.

| Before (dark)             | After (light)                                                  |
| ------------------------- | -------------------------------------------------------------- |
| `bg-sidebar`              | `bg-bg-subtle`                                                 |
| `bg-panel`                | `bg-bg-subtle` (sidebar/rails) or `bg-white` (cards)           |
| `bg-main`                 | `bg-bg` (plus `bg-white` in most places)                       |
| `bg-hover`                | `bg-bg-muted`                                                  |
| `bg-card`                 | `bg-white ring-1 ring-gray-200`                                |
| `bg-input-bg`             | `bg-white ring-1 ring-gray-200`                                |
| `border-border-dark`      | `border-border`                                                |
| `divide-border-dark`      | `divide-border-subtle`                                         |
| `text-text-primary`       | `text-text-primary` (unchanged — same token name, new value)   |
| `text-text-secondary`     | `text-text-secondary` (unchanged — same token name, new value) |
| `text-text-tertiary`      | `text-text-tertiary` (unchanged — same token name, new value)  |
| `bg-accent` (primary btn) | `bg-accent` (unchanged token name, new value)                  |
| `bg-warning-bg`           | `bg-warning-bg` (unchanged token name, new value)              |

**Note:** `text-text-*` and `bg-accent`/`bg-warning-*` token _names_ are preserved — only the underlying `@theme` values change. You do not need to rewrite those classes.

---

## Task 1: Baseline — Verify current state

**Files:** none

- [ ] **Step 1: Verify TypeScript passes before changes**

Run: `yarn tsc --noEmit`
Expected: passes with no errors.

- [ ] **Step 2: Verify tests pass**

Run: `yarn test`
Expected: all tests pass.

- [ ] **Step 3: Capture the list of files using dark tokens (for the final QA pass)**

Run: `rg -l "bg-sidebar|bg-panel|bg-main|bg-card|bg-hover|bg-input-bg|border-border-dark|divide-border-dark" src/`
Expected: prints ~28 file paths. Save this output somewhere — the final task re-runs this and expects 0 matches.

- [ ] **Step 4: No commit (baseline task only)**

---

## Task 2: Rewrite `src/index.css` `@theme` block and base styles

**Files:**

- Modify: `src/index.css` (lines 1–30)

- [ ] **Step 1: Replace the `@theme` block and `html`/`body` rules**

Replace the content from line 1 through line 30 of `src/index.css` with:

```css
@import "tailwindcss";

@theme {
  /* Surfaces */
  --color-bg: #ffffff;
  --color-bg-subtle: #f9fafb;
  --color-bg-muted: #f3f4f6;
  --color-bg-panel: #ffffff;

  /* Borders */
  --color-border: #e5e7eb;
  --color-border-subtle: #f1f5f9;

  /* Text */
  --color-text-primary: #0f172a;
  --color-text-secondary: #475569;
  --color-text-tertiary: #94a3b8;

  /* Accent (blue-600 system) */
  --color-accent: #2563eb;
  --color-accent-hover: #1d4ed8;
  --color-accent-subtle: #eff6ff;
  --color-accent-subtle-fg: #1d4ed8;

  /* Semantic */
  --color-destructive: #dc2626;
  --color-destructive-subtle: #fee2e2;
  --color-success: #16a34a;
  --color-warning-bg: #fffbeb;
  --color-warning-border: #fde68a;
  --color-warning-text: #b45309;

  /* Back-compat aliases for shadcn primitives (same value as primary tokens) */
  --color-unread: #2563eb;

  /* Radii */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
}

html {
  font-size: 14px;
}

body {
  background-color: #ffffff;
  color: #0f172a;
  font-family:
    -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Helvetica, Arial,
    sans-serif;
  font-feature-settings: "cv11", "ss01";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "refactor(ui): swap dark theme tokens for light palette"
```

---

## Task 3: Rewrite `.notion-editor` and `.drag-handle` styles in `src/index.css`

**Files:**

- Modify: `src/index.css` (lines 32–231, the notion-editor/drag-handle/drop-indicator rules)

- [ ] **Step 1: Replace all rules from `/* ── Notion-like Editor Styles ── */` to end of file**

Replace the remainder of `src/index.css` (from line 32 onward) with:

```css
/* ── Notion-like Editor Styles ── */

.notion-editor-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.notion-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
}

.notion-editor-content {
  flex: 1;
  overflow: auto;
  position: relative;
  padding-left: 40px;
}

.notion-editor {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px;
  color: var(--color-text-primary);
  line-height: 1.7;
  font-size: 15px;
}

.notion-editor > * {
  margin-top: 2px;
  margin-bottom: 2px;
  padding: 3px 0;
  border-radius: 4px;
  transition: background-color 0.1s;
}

.notion-editor > *:hover {
  background-color: rgba(15, 23, 42, 0.03);
}

.notion-editor h1 {
  font-size: 1.875em;
  font-weight: 700;
  margin-top: 1.5em;
  margin-bottom: 0.25em;
  line-height: 1.3;
  color: var(--color-text-primary);
}

.notion-editor h2 {
  font-size: 1.5em;
  font-weight: 600;
  margin-top: 1.25em;
  margin-bottom: 0.25em;
  line-height: 1.35;
  color: var(--color-text-primary);
}

.notion-editor h3 {
  font-size: 1.25em;
  font-weight: 600;
  margin-top: 1em;
  margin-bottom: 0.25em;
  line-height: 1.4;
  color: var(--color-text-primary);
}

.notion-editor p {
  margin: 0;
  min-height: 1.5em;
}

.notion-editor ul,
.notion-editor ol {
  padding-left: 1.5em;
  margin: 0.25em 0;
}

.notion-editor li {
  margin: 2px 0;
}

.notion-editor li p {
  margin: 0;
}

.notion-editor blockquote {
  border-left: 3px solid var(--color-accent);
  padding-left: 1em;
  margin: 0.5em 0;
  color: var(--color-text-secondary);
}

.notion-editor pre {
  background: #f8fafc;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 16px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
  margin: 0.5em 0;
}

.notion-editor pre code {
  font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;
  color: var(--color-text-primary);
}

.notion-editor code {
  background: #f1f5f9;
  border-radius: 3px;
  padding: 2px 5px;
  font-size: 0.9em;
  font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;
  color: #e11d48;
}

.notion-editor hr {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 1.5em 0;
}

.notion-editor p.is-editor-empty:first-child::before {
  color: var(--color-text-tertiary);
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
}

/* ── Drag Handle ── */

.drag-handle {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  cursor: grab;
  color: var(--color-text-tertiary);
  opacity: 0;
  transition:
    opacity 0.15s,
    background-color 0.15s,
    color 0.15s;
  z-index: 20;
  user-select: none;
}

.notion-editor-content:hover .drag-handle {
  opacity: 0.4;
}

.drag-handle:hover {
  opacity: 1 !important;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
}

.drag-handle:active,
.drag-handle.dragging {
  cursor: grabbing;
  opacity: 1 !important;
  background: var(--color-accent);
  color: white;
}

/* ── Drop Indicator ── */

.drop-indicator {
  position: absolute;
  height: 2px;
  background: var(--color-accent);
  border-radius: 1px;
  pointer-events: none;
  z-index: 15;
  box-shadow: 0 0 4px rgba(37, 99, 235, 0.35);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "refactor(ui): light-theme TipTap editor and drag-handle styles"
```

---

## Task 4: Create `useSidebarCollapsed` hook

**Files:**

- Create: `src/lib/useSidebarCollapsed.ts`

- [ ] **Step 1: Write the hook**

Create `src/lib/useSidebarCollapsed.ts`:

```ts
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "cmail:sidebar-collapsed";

function readStored(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => readStored());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "true" : "false");
    } catch {
      /* no-op */
    }
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((v) => !v), []);

  return [collapsed, toggle];
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/lib/useSidebarCollapsed.ts
git commit -m "feat(ui): add useSidebarCollapsed hook with localStorage persistence"
```

---

## Task 5: Rewrite UI primitive — `button.tsx`

**Files:**

- Modify: `src/components/ui/button.tsx`

- [ ] **Step 1: Replace the file contents**

Replace `src/components/ui/button.tsx` entirely with:

```tsx
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-white shadow-sm hover:bg-accent-hover",
        destructive: "bg-destructive text-white shadow-sm hover:bg-red-700",
        outline:
          "bg-white text-text-primary ring-1 ring-gray-200 hover:bg-bg-muted",
        secondary:
          "bg-white text-text-primary ring-1 ring-gray-200 hover:bg-bg-muted",
        ghost: "text-text-secondary hover:bg-bg-muted hover:text-text-primary",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 py-1.5",
        sm: "h-7 rounded-md px-2.5 text-xs",
        lg: "h-10 rounded-lg px-5",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
```

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/button.tsx
git commit -m "refactor(ui): light-theme button variants"
```

---

## Task 6: Rewrite UI primitives — `input.tsx` + `textarea.tsx`

**Files:**

- Modify: `src/components/ui/input.tsx`
- Modify: `src/components/ui/textarea.tsx`

- [ ] **Step 1: Replace `input.tsx`**

```tsx
import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md bg-white px-3 py-1.5 text-sm text-text-primary ring-1 ring-gray-200 transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
```

- [ ] **Step 2: Replace `textarea.tsx`**

```tsx
import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[60px] w-full rounded-md bg-white px-3 py-2 text-sm text-text-primary ring-1 ring-gray-200 transition-colors placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
```

- [ ] **Step 3: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/input.tsx src/components/ui/textarea.tsx
git commit -m "refactor(ui): light-theme input and textarea"
```

---

## Task 7: Rewrite UI primitive — `card.tsx`

**Files:**

- Modify: `src/components/ui/card.tsx`

- [ ] **Step 1: Replace `card.tsx`**

```tsx
import * as React from "react";

import { cn } from "@/lib/utils";

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-xl bg-white text-text-primary ring-1 ring-gray-200 shadow-sm",
      className,
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "font-semibold leading-none tracking-tight text-text-primary",
      className,
    )}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-text-secondary", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
};
```

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/card.tsx
git commit -m "refactor(ui): light-theme card"
```

---

## Task 8: Rewrite UI primitive — `dialog.tsx`

**Files:**

- Modify: `src/components/ui/dialog.tsx`

- [ ] **Step 1: Replace `dialog.tsx`**

```tsx
"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl bg-white p-6 text-text-primary shadow-lg ring-1 ring-gray-200 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm text-text-tertiary opacity-80 transition hover:bg-bg-muted hover:text-text-primary hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-accent/40">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className,
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight text-text-primary",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-text-secondary", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
```

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/dialog.tsx
git commit -m "refactor(ui): light-theme dialog"
```

---

## Task 9: Rewrite UI primitive — `dropdown-menu.tsx`

**Files:**

- Modify: `src/components/ui/dropdown-menu.tsx`

- [ ] **Step 1: Update color classes in all item-like elements**

Within `src/components/ui/dropdown-menu.tsx`, replace the `className` values on these components:

For `DropdownMenuSubTrigger`:

```tsx
className={cn(
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-primary outline-none focus:bg-bg-muted data-[state=open]:bg-bg-muted [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  inset && "pl-8",
  className,
)}
```

For `DropdownMenuSubContent`:

```tsx
className={cn(
  "z-50 min-w-[8rem] overflow-hidden rounded-lg bg-white p-1 text-text-primary shadow-md ring-1 ring-gray-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-dropdown-menu-content-transform-origin]",
  className,
)}
```

For `DropdownMenuContent`:

```tsx
className={cn(
  "z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-lg bg-white p-1 text-text-primary shadow-md ring-1 ring-gray-200",
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-dropdown-menu-content-transform-origin]",
  className,
)}
```

For `DropdownMenuItem`:

```tsx
className={cn(
  "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-primary outline-none transition-colors focus:bg-bg-muted focus:text-text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
  inset && "pl-8",
  className,
)}
```

For `DropdownMenuCheckboxItem` and `DropdownMenuRadioItem`:

```tsx
className={cn(
  "relative flex cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2 text-sm text-text-primary outline-none transition-colors focus:bg-bg-muted focus:text-text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
  className,
)}
```

For `DropdownMenuLabel`:

```tsx
className={cn(
  "px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-text-secondary",
  inset && "pl-8",
  className,
)}
```

For `DropdownMenuSeparator`:

```tsx
className={cn("-mx-1 my-1 h-px bg-border-subtle", className)}
```

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/dropdown-menu.tsx
git commit -m "refactor(ui): light-theme dropdown-menu"
```

---

## Task 10: Rewrite UI primitives — `badge.tsx` + `avatar.tsx`

**Files:**

- Modify: `src/components/ui/badge.tsx`
- Modify: `src/components/ui/avatar.tsx`

- [ ] **Step 1: Replace `badge.tsx`**

```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40",
  {
    variants: {
      variant: {
        default: "bg-accent-subtle text-accent-subtle-fg",
        secondary: "bg-bg-muted text-text-secondary",
        destructive: "bg-destructive-subtle text-destructive",
        success: "bg-emerald-50 text-emerald-700",
        warning: "bg-warning-bg text-warning-text",
        outline: "text-text-primary ring-1 ring-gray-200",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
```

- [ ] **Step 2: Replace `avatar.tsx`**

```tsx
"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";

import { cn } from "@/lib/utils";

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex h-9 w-9 shrink-0 overflow-hidden rounded-full",
      className,
    )}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn("aspect-square h-full w-full", className)}
    {...props}
  />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full bg-accent text-sm font-semibold text-white",
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
```

- [ ] **Step 3: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/badge.tsx src/components/ui/avatar.tsx
git commit -m "refactor(ui): light-theme badge and avatar"
```

---

## Task 11: Rewrite UI primitives — `label.tsx`, `separator.tsx`, `scroll-area.tsx`

**Files:**

- Modify: `src/components/ui/label.tsx`
- Modify: `src/components/ui/separator.tsx`
- Modify: `src/components/ui/scroll-area.tsx`

- [ ] **Step 1: Replace `label.tsx`**

```tsx
import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const labelVariants = cva(
  "text-sm font-medium leading-none text-text-primary peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
);

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(labelVariants(), className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
```

- [ ] **Step 2: Replace `separator.tsx`**

```tsx
"use client";

import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

import { cn } from "@/lib/utils";

const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(
  (
    { className, orientation = "horizontal", decorative = true, ...props },
    ref,
  ) => (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
        className,
      )}
      {...props}
    />
  ),
);
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
```

- [ ] **Step 3: Update `scroll-area.tsx` scrollbar thumb**

In `src/components/ui/scroll-area.tsx`, find this line:

```tsx
<ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
```

and replace the className with:

```tsx
<ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-slate-300 transition-colors hover:bg-slate-400" />
```

- [ ] **Step 4: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/label.tsx src/components/ui/separator.tsx src/components/ui/scroll-area.tsx
git commit -m "refactor(ui): light-theme label, separator, scroll-area"
```

---

## Task 12: Rewrite `Sidebar.tsx` — collapsible layout

**Files:**

- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Replace the file contents**

```tsx
import { useLocation, useNavigate } from "react-router-dom";
import {
  Mail,
  FileText,
  Key,
  Settings,
  Users,
  PenSquare,
  LogOut,
  ListOrdered,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { signOut, useSession } from "@/lib/auth-client";
import { useBranding } from "@/lib/branding";
import { useSidebarCollapsed } from "@/lib/useSidebarCollapsed";
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
  { icon: ListOrdered, label: "Sequences", path: "/sequences" },
  { icon: Key, label: "API", path: "/api-keys" },
  { icon: Settings, label: "Inboxes", path: "/inboxes", adminOnly: true },
  { icon: Users, label: "Users", path: "/admin/users", adminOnly: true },
];

function NavButton({
  icon: Icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  if (collapsed) {
    return (
      <button
        onClick={onClick}
        title={label}
        className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
          active
            ? "bg-accent-subtle text-accent-subtle-fg"
            : "text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
        }`}
      >
        <Icon size={18} />
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className={`flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm transition-colors ${
        active
          ? "bg-accent-subtle text-accent-subtle-fg"
          : "text-text-secondary hover:bg-bg-muted hover:text-text-primary"
      }`}
    >
      <Icon size={16} />
      <span className="truncate">{label}</span>
    </button>
  );
}

interface SidebarProps {
  onCompose: () => void;
}

export default function Sidebar({ onCompose }: SidebarProps) {
  const { logoLetter, name } = useBranding();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();

  function isActive(path: string) {
    if (path === "/") {
      return location.pathname === "/" || location.pathname.startsWith("/?");
    }
    return location.pathname.startsWith(path);
  }

  const widthClass = collapsed ? "w-16" : "w-56";

  return (
    <div
      className={`flex h-full flex-col border-r border-border bg-bg-subtle transition-[width] duration-150 ${widthClass}`}
    >
      {/* Header */}
      <div
        className={`flex items-center ${collapsed ? "justify-center px-0" : "px-3"} py-3`}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-sm font-bold text-white">
          {logoLetter}
        </div>
        {!collapsed && (
          <span className="ml-2 truncate text-sm font-semibold text-text-primary">
            {name}
          </span>
        )}
      </div>

      {/* Nav items */}
      <nav
        className={`flex flex-1 flex-col gap-1 ${collapsed ? "items-center px-2" : "px-2"}`}
      >
        {navItems
          .filter((item) => !item.adminOnly || session?.user?.role === "admin")
          .map((item) => (
            <NavButton
              key={item.path}
              icon={item.icon}
              label={item.label}
              active={isActive(item.path)}
              collapsed={collapsed}
              onClick={() => navigate(item.path)}
            />
          ))}

        {/* Compose (primary CTA) */}
        <div className={`mt-3 ${collapsed ? "" : "px-0"}`}>
          {collapsed ? (
            <button
              onClick={onCompose}
              title="Compose"
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-white shadow-sm transition-colors hover:bg-accent-hover"
            >
              <PenSquare size={18} />
            </button>
          ) : (
            <button
              onClick={onCompose}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover"
            >
              <PenSquare size={16} />
              Compose
            </button>
          )}
        </div>
      </nav>

      {/* Footer */}
      <div
        className={`flex items-center border-t border-border-subtle ${
          collapsed ? "flex-col gap-1 px-2 py-2" : "justify-between px-2 py-2"
        }`}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title={session?.user?.email || "Account"}
              className={`flex items-center gap-2 rounded-md transition-colors hover:bg-bg-muted ${
                collapsed ? "h-10 w-10 justify-center" : "h-10 flex-1 px-2"
              }`}
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
                {session?.user?.name?.[0]?.toUpperCase() || "?"}
              </div>
              {!collapsed && (
                <span className="truncate text-left text-xs text-text-secondary">
                  {session?.user?.email}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <DropdownMenuItem onClick={() => signOut()}>
              <LogOut size={14} />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Confirm `useBranding()` exposes `name`**

Run: `rg "name" src/lib/branding.tsx`
Expected: output includes the `name` field being returned.

If `name` is not exposed, fall back to using the page title or a hardcoded string in the header — but first check the file. If absent, open `src/lib/branding.tsx` and replace the `name` import with `logoLetter` repeated, or use: `<span className="ml-2 truncate text-sm font-semibold text-text-primary">cmail</span>`.

- [ ] **Step 3: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(ui): collapsible light-theme sidebar"
```

---

## Task 13: Retheme `DashboardLayout.tsx`

**Files:**

- Modify: `src/components/DashboardLayout.tsx`

- [ ] **Step 1: Replace `bg-main` with `bg-bg`**

In `src/components/DashboardLayout.tsx`, change:

```tsx
<div className="flex h-screen bg-main">
```

to:

```tsx
<div className="flex h-screen bg-bg">
```

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/DashboardLayout.tsx
git commit -m "refactor(ui): light-theme dashboard layout background"
```

---

## Task 14: Retheme `ThreadSidebar.tsx`

**Files:**

- Modify: `src/components/ThreadSidebar.tsx`

- [ ] **Step 1: Apply class substitutions**

In `src/components/ThreadSidebar.tsx`, apply these changes:

Replace:

```tsx
<div className="flex h-full w-80 shrink-0 flex-col border-l border-border-dark bg-panel max-md:absolute max-md:right-0 max-md:top-0 max-md:z-10 max-md:w-full max-md:border-l-0">
```

with:

```tsx
<div className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-bg-subtle max-md:absolute max-md:right-0 max-md:top-0 max-md:z-10 max-md:w-full max-md:border-l-0">
```

Replace:

```tsx
<div className="flex items-center justify-between border-b border-border-dark px-4 py-3">
  <h3 className="text-xs font-semibold text-text-primary">Thread</h3>
  <button
    onClick={onClose}
    className="rounded p-0.5 text-text-tertiary hover:bg-hover hover:text-text-secondary"
  >
```

with:

```tsx
<div className="flex items-center justify-between border-b border-border px-4 py-3">
  <h3 className="text-xs font-medium uppercase tracking-wide text-text-secondary">Thread</h3>
  <button
    onClick={onClose}
    className="rounded p-0.5 text-text-tertiary hover:bg-bg-muted hover:text-text-secondary"
  >
```

Replace:

```tsx
<div className="divide-y divide-border-dark">
```

with:

```tsx
<div className="divide-y divide-border-subtle">
```

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/ThreadSidebar.tsx
git commit -m "refactor(ui): light-theme ThreadSidebar"
```

---

## Task 15: Retheme `MessageBubble.tsx`

**Files:**

- Modify: `src/components/MessageBubble.tsx`

- [ ] **Step 1: Open the file and apply this class mapping**

Read the current file contents. Apply these substitutions globally within `src/components/MessageBubble.tsx`:

| Before                  | After                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `bg-panel`              | `bg-white ring-1 ring-gray-200` (drop any `border border-border-dark` on the same element) |
| `bg-card`               | `bg-white ring-1 ring-gray-200`                                                            |
| `bg-hover`              | `bg-bg-muted`                                                                              |
| `border-border-dark`    | `border-border`                                                                            |
| `hover:bg-hover`        | `hover:bg-bg-muted`                                                                        |
| `bg-warning-bg`         | `bg-amber-50`                                                                              |
| `border-warning-border` | `ring-1 ring-amber-200` (replacing `border border-warning-border`)                         |
| `text-warning-text`     | `text-amber-700`                                                                           |

If a draft-message highlight exists, ensure it uses `bg-amber-50 ring-1 ring-amber-200` instead of dark warning tokens.

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep the file for leftover dark tokens**

Run: `rg "bg-panel|bg-card|bg-hover|border-border-dark|bg-warning-bg|border-warning-border|text-warning-text" src/components/MessageBubble.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/components/MessageBubble.tsx
git commit -m "refactor(ui): light-theme MessageBubble with draft highlight"
```

---

## Task 16: Retheme `ReplyComposer.tsx`

**Files:**

- Modify: `src/components/ReplyComposer.tsx`

- [ ] **Step 1: Apply class substitutions**

Apply these global substitutions within `src/components/ReplyComposer.tsx`:

| Before               | After                           |
| -------------------- | ------------------------------- |
| `bg-panel`           | `bg-white`                      |
| `bg-card`            | `bg-white ring-1 ring-gray-200` |
| `bg-hover`           | `bg-bg-muted`                   |
| `bg-input-bg`        | `bg-white ring-1 ring-gray-200` |
| `border-border-dark` | `border-border`                 |
| `hover:bg-hover`     | `hover:bg-bg-muted`             |

Also ensure the primary Send button uses `bg-accent text-white hover:bg-accent-hover` (if inline — if it uses `<Button variant="default">` from shadcn already, no change needed).

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep**

Run: `rg "bg-panel|bg-card|bg-hover|bg-input-bg|border-border-dark" src/components/ReplyComposer.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/components/ReplyComposer.tsx
git commit -m "refactor(ui): light-theme ReplyComposer"
```

---

## Task 17: Retheme `PersonList.tsx`

**Files:**

- Modify: `src/pages/PersonList.tsx`

- [ ] **Step 1: Apply class substitutions**

Apply these global substitutions within `src/pages/PersonList.tsx`:

| Before                                                                                  | After                           |
| --------------------------------------------------------------------------------------- | ------------------------------- |
| `bg-sidebar`                                                                            | `bg-bg-subtle`                  |
| `bg-panel`                                                                              | `bg-bg-subtle`                  |
| `bg-main`                                                                               | `bg-white`                      |
| `bg-hover`                                                                              | `bg-bg-muted`                   |
| `hover:bg-hover`                                                                        | `hover:bg-bg-muted`             |
| `bg-card`                                                                               | `bg-white ring-1 ring-gray-200` |
| `bg-input-bg`                                                                           | `bg-white ring-1 ring-gray-200` |
| `border-border-dark`                                                                    | `border-border`                 |
| `divide-border-dark`                                                                    | `divide-border-subtle`          |
| `bg-accent text-white` (for selected row — keep, but add accent-subtle variant instead) | see step 2                      |

- [ ] **Step 2: Update the selected-row styling**

Wherever a person row's "selected" state is applied, change the selected class from something like `bg-accent text-white` (if present) to:

```
bg-accent-subtle border-l-[3px] border-l-accent
```

and keep text classes as-is (text-text-primary/secondary). If the existing selected state is already subtle, just ensure it uses `bg-accent-subtle` with a left accent border.

- [ ] **Step 3: Update the unread dot**

If an unread indicator uses `bg-unread` or `bg-[#something]`, confirm it uses `bg-accent` (blue-600). The token-renamed value is correct; just make sure it's not hardcoded to a dark color.

- [ ] **Step 4: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Grep**

Run: `rg "bg-sidebar|bg-panel|bg-main|bg-hover|bg-card|bg-input-bg|border-border-dark|divide-border-dark" src/pages/PersonList.tsx`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add src/pages/PersonList.tsx
git commit -m "refactor(ui): light-theme PersonList with subtle selected state"
```

---

## Task 18: Retheme `PersonDetail.tsx`

**Files:**

- Modify: `src/pages/PersonDetail.tsx`

- [ ] **Step 1: Apply global class substitutions**

Within `src/pages/PersonDetail.tsx`:

| Before               | After                           |
| -------------------- | ------------------------------- |
| `bg-sidebar`         | `bg-bg-subtle`                  |
| `bg-panel`           | `bg-white`                      |
| `bg-main`            | `bg-white`                      |
| `bg-hover`           | `bg-bg-muted`                   |
| `hover:bg-hover`     | `hover:bg-bg-muted`             |
| `bg-card`            | `bg-white ring-1 ring-gray-200` |
| `bg-input-bg`        | `bg-white ring-1 ring-gray-200` |
| `border-border-dark` | `border-border`                 |
| `divide-border-dark` | `divide-border-subtle`          |

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep**

Run: `rg "bg-sidebar|bg-panel|bg-main|bg-hover|bg-card|bg-input-bg|border-border-dark|divide-border-dark" src/pages/PersonDetail.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/pages/PersonDetail.tsx
git commit -m "refactor(ui): light-theme PersonDetail"
```

---

## Task 19: Retheme `InboxPage.tsx`

**Files:**

- Modify: `src/pages/InboxPage.tsx`

- [ ] **Step 1: Apply class substitutions**

Replace the middle-panel div:

```tsx
<div
  className={`w-full md:w-80 shrink-0 border-r border-border-dark bg-panel ${
    selectedPerson ? "hidden md:block" : "block"
  }`}
>
```

with:

```tsx
<div
  className={`w-full md:w-80 shrink-0 border-r border-border bg-bg-subtle ${
    selectedPerson ? "hidden md:block" : "block"
  }`}
>
```

Replace the right-panel div:

```tsx
<div
  className={`flex-1 bg-main min-w-0 ${
    selectedPerson ? "block" : "hidden md:block"
  }`}
>
```

with:

```tsx
<div
  className={`flex-1 bg-white min-w-0 ${
    selectedPerson ? "block" : "hidden md:block"
  }`}
>
```

Replace the mobile back button:

```tsx
<button
  onClick={() => setSelectedPerson(null)}
  className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-secondary hover:text-text-primary md:hidden border-b border-border-dark"
>
```

with:

```tsx
<button
  onClick={() => setSelectedPerson(null)}
  className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-secondary hover:text-text-primary md:hidden border-b border-border"
>
```

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep**

Run: `rg "bg-panel|bg-main|border-border-dark" src/pages/InboxPage.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/pages/InboxPage.tsx
git commit -m "refactor(ui): light-theme InboxPage panes"
```

---

## Task 20: Retheme `ComposeModal.tsx`

**Files:**

- Modify: `src/pages/ComposeModal.tsx`

- [ ] **Step 1: Apply global class substitutions**

| Before               | After                           |
| -------------------- | ------------------------------- |
| `bg-panel`           | `bg-white`                      |
| `bg-main`            | `bg-white`                      |
| `bg-card`            | `bg-white`                      |
| `bg-input-bg`        | `bg-white ring-1 ring-gray-200` |
| `bg-hover`           | `bg-bg-muted`                   |
| `hover:bg-hover`     | `hover:bg-bg-muted`             |
| `border-border-dark` | `border-border`                 |
| `divide-border-dark` | `divide-border-subtle`          |

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep**

Run: `rg "bg-panel|bg-main|bg-card|bg-input-bg|bg-hover|border-border-dark|divide-border-dark" src/pages/ComposeModal.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/pages/ComposeModal.tsx
git commit -m "refactor(ui): light-theme ComposeModal"
```

---

## Task 21: Retheme `TiptapEditor.tsx`

**Files:**

- Modify: `src/components/TiptapEditor.tsx`

- [ ] **Step 1: Apply global class substitutions**

| Before               | After               |
| -------------------- | ------------------- |
| `bg-panel`           | `bg-white`          |
| `bg-hover`           | `bg-bg-muted`       |
| `hover:bg-hover`     | `hover:bg-bg-muted` |
| `border-border-dark` | `border-border`     |

The `.notion-editor` CSS was already updated in Task 3, so visual styles come from there.

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep**

Run: `rg "bg-panel|bg-hover|border-border-dark" src/components/TiptapEditor.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/components/TiptapEditor.tsx
git commit -m "refactor(ui): light-theme TiptapEditor wrapper"
```

---

## Task 22: Swap CodeMirror theme in `HtmlCodeEditor.tsx`

**Files:**

- Modify: `src/components/HtmlCodeEditor.tsx`

- [ ] **Step 1: Remove the `oneDark` import**

Remove this line:

```tsx
import { oneDark } from "@codemirror/theme-one-dark";
```

- [ ] **Step 2: Remove `oneDark` from the extensions array and replace the theme**

Within the `EditorState.create({ extensions: [...] })` call:

- Remove the `oneDark,` entry from the extensions array.
- Replace the existing `EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } })` entry with:

```tsx
EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "#ffffff",
    color: "#0f172a",
  },
  ".cm-scroller": { overflow: "auto" },
  ".cm-gutters": {
    backgroundColor: "#f9fafb",
    color: "#94a3b8",
    border: "none",
    borderRight: "1px solid #e5e7eb",
  },
  ".cm-activeLine": { backgroundColor: "#f3f4f6" },
  ".cm-activeLineGutter": { backgroundColor: "#f3f4f6" },
  ".cm-cursor": { borderLeftColor: "#2563eb" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "#dbeafe" },
}),
```

- [ ] **Step 3: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Confirm `theme-one-dark` import is gone**

Run: `rg "theme-one-dark" src/`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add src/components/HtmlCodeEditor.tsx
git commit -m "refactor(ui): switch CodeMirror to light theme"
```

---

## Task 23: Retheme `EmailHtmlModal.tsx` + `EnrollSequenceModal.tsx`

**Files:**

- Modify: `src/components/EmailHtmlModal.tsx`
- Modify: `src/components/EnrollSequenceModal.tsx`

- [ ] **Step 1: Apply global class substitutions to both files**

| Before               | After                           |
| -------------------- | ------------------------------- |
| `bg-panel`           | `bg-white`                      |
| `bg-main`            | `bg-white`                      |
| `bg-card`            | `bg-white`                      |
| `bg-input-bg`        | `bg-white ring-1 ring-gray-200` |
| `bg-hover`           | `bg-bg-muted`                   |
| `hover:bg-hover`     | `hover:bg-bg-muted`             |
| `border-border-dark` | `border-border`                 |

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep both files**

Run: `rg "bg-panel|bg-main|bg-card|bg-input-bg|bg-hover|border-border-dark" src/components/EmailHtmlModal.tsx src/components/EnrollSequenceModal.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/components/EmailHtmlModal.tsx src/components/EnrollSequenceModal.tsx
git commit -m "refactor(ui): light-theme email HTML and enrollment modals"
```

---

## Task 24: Retheme `AdminInboxTable.tsx` + `SequenceStatus.tsx`

**Files:**

- Modify: `src/components/AdminInboxTable.tsx`
- Modify: `src/components/SequenceStatus.tsx`

- [ ] **Step 1: Apply global class substitutions to both files**

| Before               | After                           |
| -------------------- | ------------------------------- |
| `bg-panel`           | `bg-white`                      |
| `bg-main`            | `bg-white`                      |
| `bg-card`            | `bg-white ring-1 ring-gray-200` |
| `bg-hover`           | `bg-bg-muted`                   |
| `hover:bg-hover`     | `hover:bg-bg-muted`             |
| `border-border-dark` | `border-border`                 |
| `divide-border-dark` | `divide-border-subtle`          |

For `SequenceStatus` status pills, ensure the color mappings are:

- Active → `bg-emerald-50 text-emerald-700` (or keep `<Badge variant="success">` if the component uses badge now — after Task 10 the success variant exists).
- Paused → `bg-warning-bg text-warning-text`
- Draft → `bg-bg-muted text-text-secondary`

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep**

Run: `rg "bg-panel|bg-main|bg-card|bg-hover|border-border-dark|divide-border-dark" src/components/AdminInboxTable.tsx src/components/SequenceStatus.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/components/AdminInboxTable.tsx src/components/SequenceStatus.tsx
git commit -m "refactor(ui): light-theme admin inbox table and sequence status pills"
```

---

## Task 25: Retheme `InboxesPage.tsx` + `AdminUsersPage.tsx`

**Files:**

- Modify: `src/pages/InboxesPage.tsx`
- Modify: `src/pages/AdminUsersPage.tsx`

- [ ] **Step 1: Apply global class substitutions to both files**

| Before               | After                           |
| -------------------- | ------------------------------- |
| `bg-sidebar`         | `bg-bg-subtle`                  |
| `bg-panel`           | `bg-white`                      |
| `bg-main`            | `bg-white`                      |
| `bg-card`            | `bg-white ring-1 ring-gray-200` |
| `bg-input-bg`        | `bg-white ring-1 ring-gray-200` |
| `bg-hover`           | `bg-bg-muted`                   |
| `hover:bg-hover`     | `hover:bg-bg-muted`             |
| `border-border-dark` | `border-border`                 |
| `divide-border-dark` | `divide-border-subtle`          |

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep**

Run: `rg "bg-sidebar|bg-panel|bg-main|bg-card|bg-input-bg|bg-hover|border-border-dark|divide-border-dark" src/pages/InboxesPage.tsx src/pages/AdminUsersPage.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/pages/InboxesPage.tsx src/pages/AdminUsersPage.tsx
git commit -m "refactor(ui): light-theme admin inbox and user pages"
```

---

## Task 26: Retheme `ApiKeysPage.tsx`

**Files:**

- Modify: `src/pages/ApiKeysPage.tsx`

- [ ] **Step 1: Apply global class substitutions**

Same mapping table as Task 25.

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep**

Run: `rg "bg-sidebar|bg-panel|bg-main|bg-card|bg-input-bg|bg-hover|border-border-dark|divide-border-dark" src/pages/ApiKeysPage.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/pages/ApiKeysPage.tsx
git commit -m "refactor(ui): light-theme API keys page"
```

---

## Task 27: Retheme Templates pages

**Files:**

- Modify: `src/pages/TemplatesPage.tsx`
- Modify: `src/pages/TemplateEditorPage.tsx`

- [ ] **Step 1: Apply global class substitutions to both files**

Same mapping table as Task 25.

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep**

Run: `rg "bg-sidebar|bg-panel|bg-main|bg-card|bg-input-bg|bg-hover|border-border-dark|divide-border-dark" src/pages/TemplatesPage.tsx src/pages/TemplateEditorPage.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/pages/TemplatesPage.tsx src/pages/TemplateEditorPage.tsx
git commit -m "refactor(ui): light-theme template pages"
```

---

## Task 28: Retheme Sequence pages

**Files:**

- Modify: `src/pages/SequencesPage.tsx`
- Modify: `src/pages/SequenceEditorPage.tsx`
- Modify: `src/pages/SequenceDetailPage.tsx`

- [ ] **Step 1: Apply global class substitutions to all three files**

Same mapping table as Task 25.

- [ ] **Step 2: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Grep**

Run: `rg "bg-sidebar|bg-panel|bg-main|bg-card|bg-input-bg|bg-hover|border-border-dark|divide-border-dark" src/pages/SequencesPage.tsx src/pages/SequenceEditorPage.tsx src/pages/SequenceDetailPage.tsx`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/pages/SequencesPage.tsx src/pages/SequenceEditorPage.tsx src/pages/SequenceDetailPage.tsx
git commit -m "refactor(ui): light-theme sequence pages"
```

---

## Task 29: Retheme auth pages

**Files:**

- Modify: `src/pages/LoginPage.tsx`
- Modify: `src/pages/OnboardingPage.tsx`
- Modify: `src/pages/InviteAcceptPage.tsx`
- Modify: `src/pages/SetupPasskeyPage.tsx`

- [ ] **Step 1: Apply global class substitutions to all four files**

Same mapping table as Task 25.

- [ ] **Step 2: For each file, ensure the centered card uses the new light card surface**

If a top-level wrapper div uses a dark background like `bg-main` or `bg-sidebar`, change it to `bg-bg-subtle`. The inner card element should be `bg-white ring-1 ring-gray-200 rounded-xl`.

- [ ] **Step 3: Verify TypeScript**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Grep**

Run: `rg "bg-sidebar|bg-panel|bg-main|bg-card|bg-input-bg|bg-hover|border-border-dark|divide-border-dark" src/pages/LoginPage.tsx src/pages/OnboardingPage.tsx src/pages/InviteAcceptPage.tsx src/pages/SetupPasskeyPage.tsx`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add src/pages/LoginPage.tsx src/pages/OnboardingPage.tsx src/pages/InviteAcceptPage.tsx src/pages/SetupPasskeyPage.tsx
git commit -m "refactor(ui): light-theme auth pages (login, onboarding, invite, passkey)"
```

---

## Task 30: Final QA pass — grep and fix stragglers

**Files:** any remaining files that still reference dark tokens.

- [ ] **Step 1: Grep the entire `src/` directory for leftover dark tokens**

Run: `rg "bg-sidebar|bg-panel|bg-main|bg-card|bg-hover|bg-input-bg|border-border-dark|divide-border-dark" src/`
Expected: **no matches**.

If any matches remain, open each file and apply the mapping table. Commit as:

```bash
git commit -m "refactor(ui): clean up remaining dark-theme class stragglers"
```

- [ ] **Step 2: Grep for leftover shadcn semantic tokens that were never defined**

Run: `rg "bg-primary|bg-secondary|text-primary-foreground|text-secondary-foreground|text-muted-foreground|text-card-foreground|text-popover-foreground|text-destructive-foreground|text-accent-foreground|bg-popover|bg-background|border-input|ring-ring|ring-offset-background|bg-muted" src/`
Expected: **no matches** (these were replaced in Tasks 5–11).

If any remain, they're in files that weren't part of the planned rewrite — open and fix them using the mapping:

- `bg-primary` → `bg-accent`
- `text-primary-foreground` → `text-white`
- `bg-card` → `bg-white ring-1 ring-gray-200`
- `text-muted-foreground` → `text-text-secondary`
- `text-foreground` → `text-text-primary`
- `bg-muted` → `bg-bg-muted`
- `bg-popover` → `bg-white`
- `text-popover-foreground` → `text-text-primary`
- `bg-background` → `bg-white`
- `border-input` → `ring-1 ring-gray-200` (replacing `border`)
- `ring-ring` → `ring-accent/40`
- `text-accent-foreground` → `text-accent-subtle-fg`
- `bg-accent` (in hover contexts) → leave (this now resolves to blue-600 — check visually if wrong)

Commit any fixes:

```bash
git commit -m "refactor(ui): replace undefined shadcn tokens with project tokens"
```

- [ ] **Step 3: Grep for `theme-one-dark`**

Run: `rg "theme-one-dark" src/`
Expected: no matches.

- [ ] **Step 4: Final TypeScript check**

Run: `yarn tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Final test run**

Run: `yarn test`
Expected: all tests pass.

- [ ] **Step 6: Manual smoke test**

Run: `yarn dev`
Open each route in the browser and visually confirm light theme:

- `/` (Inbox) — empty state + loaded state + thread open
- `/templates` and `/templates/:id`
- `/sequences`, `/sequences/:id`, `/sequences/:id/edit`
- `/api-keys`
- `/inboxes` (admin)
- `/admin/users` (admin)
- `/login` (sign out first to see)
- `/onboarding` (if achievable)
- Sidebar collapse/expand toggle works, preference persists across refresh.

Fix anything that looks broken. Commit fixes.

- [ ] **Step 7: Final commit if no fixes needed**

If Steps 1–5 all pass cleanly, no additional commit is needed. Otherwise:

```bash
git commit -m "refactor(ui): final QA fixes for light theme"
```

---

## Summary

30 tasks total. Tasks 1–11 establish the token system and primitives. Tasks 12–13 rewrite the layout shell. Tasks 14–22 retheme inbox surfaces and editors. Tasks 23–29 retheme auxiliary pages. Task 30 is the final sweep.

At the end: zero dark tokens remain, TypeScript compiles, tests pass, the app is fully light-themed with a collapsible sidebar and unified blue accent system.
