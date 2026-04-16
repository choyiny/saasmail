# Email Provider Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct `Resend` calls with an `EmailSender` abstraction that auto-selects between Resend and Cloudflare Email Sending based on which env var/binding is configured.

**Architecture:** One interface, two adapters. A factory picks the adapter at runtime: Resend wins if `RESEND_API_KEY` is set, else Cloudflare wins if `env.EMAIL` binding is present, else a stub adapter returns `{ id: null, error: { message: "No email provider configured" } }`.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, Resend SDK, Cloudflare `send_email` binding, Vitest.

Spec: `docs/superpowers/specs/2026-04-16-email-provider-abstraction-design.md`

---

## File Structure

- `worker/src/lib/email-sender.ts` (new) — interface, two adapters, factory.
- `worker/src/__tests__/email-sender.test.ts` (new) — unit tests for the factory and the Cloudflare adapter error path.
- `worker/src/routers/send-router.ts` — swap `new Resend(...)` for `createEmailSender(c.env)` in two handlers.
- `worker/src/routers/email-templates-router.ts` — same swap in the template send handler.
- `worker/src/lib/sequence-processor.ts` — same swap in `processSequenceEmail`.
- `wrangler.jsonc.example` — add commented `send_email` binding example.

---

## Task 1: Create the `EmailSender` interface and factory with tests

**Files:**
- Create: `worker/src/lib/email-sender.ts`
- Create: `worker/src/__tests__/email-sender.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/src/__tests__/email-sender.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createEmailSender } from "../lib/email-sender";

describe("createEmailSender", () => {
  it("picks Resend when RESEND_API_KEY is set", () => {
    const sender = createEmailSender({
      RESEND_API_KEY: "re_test",
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("resend");
  });

  it("picks Cloudflare when only EMAIL binding is present", () => {
    const sender = createEmailSender({
      EMAIL: { send: vi.fn() },
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("cloudflare");
  });

  it("picks Resend when both are set (Resend takes precedence)", () => {
    const sender = createEmailSender({
      RESEND_API_KEY: "re_test",
      EMAIL: { send: vi.fn() },
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("resend");
  });

  it("returns a stub when neither is configured", async () => {
    const sender = createEmailSender({} as unknown as CloudflareBindings);
    expect(sender.provider).toBe("none");
    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(result.id).toBeNull();
    expect(result.error?.message).toBe("No email provider configured");
  });
});

describe("CloudflareSender", () => {
  it("returns messageId on success", async () => {
    const fakeBinding = {
      send: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
    };
    const sender = createEmailSender({
      EMAIL: fakeBinding,
    } as unknown as CloudflareBindings);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hello",
      html: "<p>hi</p>",
      text: "hi",
      headers: { "In-Reply-To": "<orig@msg>" },
    });

    expect(result.id).toBe("msg-123");
    expect(result.error).toBeNull();
    expect(fakeBinding.send).toHaveBeenCalledWith({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hello",
      html: "<p>hi</p>",
      text: "hi",
      headers: { "In-Reply-To": "<orig@msg>" },
    });
  });

  it("catches thrown errors and returns normalized result", async () => {
    const fakeBinding = {
      send: vi.fn().mockRejectedValue(new Error("sender not allowed")),
    };
    const sender = createEmailSender({
      EMAIL: fakeBinding,
    } as unknown as CloudflareBindings);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      html: "<p>x</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.message).toBe("sender not allowed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test worker/src/__tests__/email-sender.test.ts`
Expected: FAIL — module `../lib/email-sender` not found.

- [ ] **Step 3: Implement `worker/src/lib/email-sender.ts`**

```typescript
import { Resend } from "resend";

export interface SendEmailParams {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  id: string | null;
  error: { message: string } | null;
}

export interface EmailSender {
  provider: "resend" | "cloudflare" | "none";
  send(params: SendEmailParams): Promise<SendEmailResult>;
}

class ResendSender implements EmailSender {
  readonly provider = "resend" as const;
  private client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    const result = await this.client.emails.send({
      from: params.from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      headers: params.headers,
    });
    if (result.error) {
      return {
        id: null,
        error: { message: result.error.message ?? "Resend send failed" },
      };
    }
    return { id: result.data?.id ?? null, error: null };
  }
}

class CloudflareSender implements EmailSender {
  readonly provider = "cloudflare" as const;
  constructor(private binding: SendEmail) {}

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    try {
      const result = await this.binding.send({
        from: params.from,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        headers: params.headers,
      });
      return { id: result.messageId, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { id: null, error: { message } };
    }
  }
}

class NoopSender implements EmailSender {
  readonly provider = "none" as const;
  async send(_: SendEmailParams): Promise<SendEmailResult> {
    return { id: null, error: { message: "No email provider configured" } };
  }
}

export function createEmailSender(
  env: CloudflareBindings & { RESEND_API_KEY?: string; EMAIL?: SendEmail },
): EmailSender {
  if (env.RESEND_API_KEY) {
    return new ResendSender(env.RESEND_API_KEY);
  }
  if (env.EMAIL) {
    return new CloudflareSender(env.EMAIL);
  }
  return new NoopSender();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test worker/src/__tests__/email-sender.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/email-sender.ts worker/src/__tests__/email-sender.test.ts
git commit -m "feat: add EmailSender abstraction with Resend and Cloudflare adapters"
```

---

## Task 2: Migrate `send-router.ts` to use `EmailSender`

**Files:**
- Modify: `worker/src/routers/send-router.ts`

- [ ] **Step 1: Read the current state of the file**

Run: `yarn tsc --noEmit` (baseline — should pass).

- [ ] **Step 2: Update the compose-send handler**

In `worker/src/routers/send-router.ts`, replace the import:

```typescript
// remove:
import { Resend } from "resend";
// add:
import { createEmailSender } from "../lib/email-sender";
```

Inside the `sendEmailRoute` handler (around line 54-68), replace:

```typescript
  // Send via Resend
  const resend = new Resend(c.env.RESEND_API_KEY);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const result = await resend.emails.send({
    from: formattedFrom,
    to,
    subject,
    html: bodyHtml,
    text: bodyText,
  });
```

With:

```typescript
  const sender = createEmailSender(c.env);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const result = await sender.send({
    from: formattedFrom,
    to,
    subject,
    html: bodyHtml,
    text: bodyText,
  });
```

Then further down in the same handler, replace:

```typescript
    resendId: result.data?.id ?? null,
    status: result.error ? "failed" : "sent",
```

With:

```typescript
    resendId: result.id,
    status: result.error ? "failed" : "sent",
```

And in the final `c.json` response, replace:

```typescript
      resendId: result.data?.id ?? null,
      status: result.error ? "failed" : "sent",
```

With:

```typescript
      resendId: result.id,
      status: result.error ? "failed" : "sent",
```

- [ ] **Step 3: Update the reply handler**

Inside the `replyEmailRoute` handler (around line 221-231), replace:

```typescript
  // Send via Resend
  const resend = new Resend(c.env.RESEND_API_KEY);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const result = await resend.emails.send({
    from: formattedFrom,
    to: toAddress,
    subject: finalSubject,
    html: finalBodyHtml,
    text: bodyText,
    headers: orig.messageId ? { "In-Reply-To": orig.messageId } : undefined,
  });
```

With:

```typescript
  const sender = createEmailSender(c.env);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const result = await sender.send({
    from: formattedFrom,
    to: toAddress,
    subject: finalSubject,
    html: finalBodyHtml,
    text: bodyText,
    headers: orig.messageId ? { "In-Reply-To": orig.messageId } : undefined,
  });
```

Replace the two remaining `result.data?.id ?? null` occurrences with `result.id`.

- [ ] **Step 4: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run send-router tests**

Run: `yarn test worker/src/__tests__/send-router`
Expected: PASS. If existing tests break because they assume `result.data?.id`, the failure will point to the test file; open it, replace `result.data?.id` with `result.id` only in assertions that inspect the returned shape (the `sentEmails` row and API response use `resendId` which is unchanged).

- [ ] **Step 6: Commit**

```bash
git add worker/src/routers/send-router.ts
git commit -m "refactor: route send-router through EmailSender abstraction"
```

---

## Task 3: Migrate `email-templates-router.ts` to use `EmailSender`

**Files:**
- Modify: `worker/src/routers/email-templates-router.ts`

- [ ] **Step 1: Swap the import**

Replace the `Resend` import at the top of the file:

```typescript
// remove:
import { Resend } from "resend";
// add:
import { createEmailSender } from "../lib/email-sender";
```

- [ ] **Step 2: Update the send handler**

Around line 321, replace:

```typescript
  // Send via Resend
  const resend = new Resend(c.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: fromAddress,
    to,
    subject: renderedSubject,
    html: renderedHtml,
  });
```

With:

```typescript
  const sender = createEmailSender(c.env);
  const result = await sender.send({
    from: fromAddress,
    to,
    subject: renderedSubject,
    html: renderedHtml,
  });
```

Then replace the two `result.data?.id ?? null` usages (in the sentEmails insert and the response) with `result.id`. Status logic (`result.error ? "failed" : "sent"`) is unchanged.

- [ ] **Step 3: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run template-router tests**

Run: `yarn test worker/src/__tests__/email-templates-router`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/routers/email-templates-router.ts
git commit -m "refactor: route email-templates-router through EmailSender abstraction"
```

---

## Task 4: Migrate `sequence-processor.ts` to use `EmailSender`

**Files:**
- Modify: `worker/src/lib/sequence-processor.ts`

- [ ] **Step 1: Swap the import**

Replace the `Resend` import at the top:

```typescript
// remove:
import { Resend } from "resend";
// add:
import { createEmailSender, type EmailSender } from "./email-sender";
```

- [ ] **Step 2: Replace the Resend instance in the queue batch handler**

Find where the handler currently creates `const resend = new Resend(env.RESEND_API_KEY);` (around line 60). Replace with:

```typescript
  const sender = createEmailSender(env);
```

- [ ] **Step 3: Update `processSequenceEmail` signature and call site**

In `processSequenceEmail` (around line 57), change the parameter from `resend: Resend` to `sender: EmailSender`. Update the call in the batch loop to pass `sender` instead of `resend`.

Inside `processSequenceEmail`, replace (around line 165):

```typescript
  // Send via Resend
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const result = await resend.emails.send({
    from: formattedFrom,
    to: person.email,
    subject: renderedSubject,
    html: renderedHtml,
  });
```

With:

```typescript
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const result = await sender.send({
    from: formattedFrom,
    to: person.email,
    subject: renderedSubject,
    html: renderedHtml,
  });
```

Replace the `result.data?.id ?? null` in the `sentEmails` insert with `result.id`. The `result.error` check stays as-is.

- [ ] **Step 4: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run sequence-processor tests**

Run: `yarn test worker/src/__tests__/sequence-processor`
Expected: PASS (the 4 pre-existing failures in this file are unrelated — `from_address NOT NULL`. Verify the set of failing tests is unchanged from baseline on `main`.)

To confirm no new failures:

```bash
git stash
yarn test worker/src/__tests__/sequence-processor 2>&1 | grep FAIL > /tmp/baseline-fails.txt
git stash pop
yarn test worker/src/__tests__/sequence-processor 2>&1 | grep FAIL > /tmp/current-fails.txt
diff /tmp/baseline-fails.txt /tmp/current-fails.txt
```

Expected: empty diff.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/sequence-processor.ts
git commit -m "refactor: route sequence-processor through EmailSender abstraction"
```

---

## Task 5: Update config examples

**Files:**
- Modify: `wrangler.jsonc.example`

- [ ] **Step 1: Add commented `send_email` binding**

In `wrangler.jsonc.example`, insert after the `r2_buckets` block (around line 28) and before `assets`:

```jsonc
  // Optional: enable Cloudflare Email Sending as the outbound provider.
  // If RESEND_API_KEY is set, Resend is used instead. Requires onboarding
  // your domain at Email Service → https://dash.cloudflare.com/?to=/:account/email-service
  // "send_email": [
  //   { "name": "EMAIL" }
  // ],
```

- [ ] **Step 2: Document env var selection**

Find the `vars` block. Above it, insert a top-level comment:

```jsonc
  // Outbound email provider selection (runtime, no explicit toggle):
  //   - Set RESEND_API_KEY (via `wrangler secret put RESEND_API_KEY`) to use Resend.
  //   - Or uncomment the `send_email` binding above to use Cloudflare Email Sending.
  //   - If neither is configured, send attempts return a "No email provider configured" error.
```

- [ ] **Step 3: Verify syntax**

Run: `yarn tsc --noEmit`
Expected: no errors (this doesn't validate wrangler.jsonc.example directly, but confirms nothing else broke).

Manually inspect the file and confirm it's still valid JSONC (comments preserved, commas placed correctly).

- [ ] **Step 4: Commit**

```bash
git add wrangler.jsonc.example
git commit -m "docs: document Cloudflare Email Sending option in wrangler example"
```

---

## Task 6: Full verification and push

- [ ] **Step 1: Full test suite**

Run: `yarn test 2>&1 | tail -20`
Expected: same pass/fail count as before this plan started. Pre-existing failures (cancel-sequence + sequence-processor, 4 total) should still be failing for the same `from_address NOT NULL` reason. No new failures.

- [ ] **Step 2: Type-check**

Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke-check the build** (optional — only if deploy is planned immediately)

Run: `yarn build`
Expected: success. Skip if not deploying right away.

- [ ] **Step 4: Push**

```bash
git push
```

---

## Self-review notes

- Spec's "factory" section is covered by Task 1.
- Spec's "three call sites" is covered by Tasks 2, 3, 4.
- Spec's "config changes" is covered by Task 5.
- Spec's "testing" is covered by Task 1's test file.
- Spec's "out of scope" items — `resendId` column rename, admin UI, REST fallback — are not in any task, correctly.
- `result.data?.id ?? null` → `result.id` replacement is consistent across all three call sites (same property name on the normalized `SendEmailResult`).
- The `EmailSender` interface uses the same property names in every task (`provider`, `send`, `id`, `error`).
