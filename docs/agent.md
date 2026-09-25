[saasmail](../README.md) › [Docs](README.md) › **Native mail agent**

# Native mail agent

Stage 2 adds a native in-app mail agent. The runtime is implemented as a
Cloudflare Durable Object using the Cloudflare `agents` SDK and
`@cloudflare/ai-chat`; chat transcripts live in that Durable Object's SQLite
storage. Mail data remains in D1, and every mail read or mutation goes through
the same permission-scoped services used elsewhere in saasmail. Stage 2b adds
the authenticated side-panel UI on top of that runtime.

## In-app panel

The **Agent** button in the top navigation opens a side panel from any
authenticated page. The keyboard shortcut is **⌘J** on macOS and **Ctrl+J** on
other platforms; pressing it again closes the panel. The open/closed preference
is stored locally in the browser.

The panel lists the caller's agent sessions and supports creating, renaming,
archiving/restoring, and deleting them. A session's transcript stays in its
Durable Object while the D1 `agent_sessions` row is the permission-scoped
directory entry used to find it.

Assistant text is rendered as sanitized Markdown. Markdown images are
intentionally not rendered: model output and quoted mail are untrusted, and an
`<img>` would make the browser automatically fetch a remote URL (including
tracking pixels) without an explicit user action. Links remain clickable after
sanitization. Reasoning parts normally stay hidden. Once an assistant message
is complete, reasoning is rendered through the same sanitizer only when there
is no non-empty final text: for a message with tools, only reasoning after the
last tool call is eligible; for a message with no tools, its reasoning can be
the fallback answer. The active submitted/streaming message never uses this
fallback, so reasoning cannot flash before a tool call or final text arrives.

Admins can set up to 4000 characters of **Agent instructions** for each inbox on
the **Inboxes** admin page. When the current navigation context identifies that
inbox, those instructions are appended to the agent prompt. They guide behavior
only; they never grant inbox access or override the runtime's permission checks.

If no Anthropic key, OpenAI key, or Workers AI binding is available, the panel
stays usable for session management but disables chat input and shows the
provider-configuration hint described below.

## Suggested replies

Suggested replies are opt-in per inbox. An admin enables **Auto-suggest replies**
on the **Inboxes** page; disabled inboxes never enqueue this work.

For each eligible received message, saasmail makes one model call to screen the
message for prompt injection and, only when the first word of the call's final
text is `SAFE` (case-insensitive, ignoring surrounding Markdown/punctuation),
one model call to draft a reply. Mail that is already Junk, carries
automated/list headers, arrives after the setting was disabled, or has no
configured model provider is skipped. The consumer re-checks the message,
inbox setting, spam/trash state, and existing suggestion before generating, so
stale or duplicate queue deliveries are harmless.

The drafting call has no tools. The current message and up to 10 recent messages
from the same person in the same inbox are quoted as untrusted data, and each
body is truncated to 4000 characters. Inbox **Agent instructions**, when set,
are included as trusted administrator guidance. The result is stored as plain
text for a human to review, use, edit, or dismiss. Drafting instructions require
facts to come from the quoted messages or trusted inbox instructions; unknown
answers should be acknowledged rather than invented. Suggested replies omit
signatures because the configured inbox signature is appended by the reply
composer when the human sends. Trailing placeholder-only sign-offs are removed,
while placeholders embedded in substantive copy make the suggestion fail
closed. **Nothing is ever sent by this feature.**

Cost per eligible message is therefore one screening call plus one generation
call. The screen and draft calls disable reasoning for providers that support
the AI SDK's unified reasoning option, and the Workers AI call also disables
Kimi/GLM thinking explicitly. A screening flag, error, timeout, missing final
text, or any first final-text word other than `SAFE` creates no suggestion.
An empty final draft is never stored.

## Provider selection

The agent selects exactly one provider per turn, in this order:

1. `ANTHROPIC_API_KEY` → Anthropic
2. `OPENAI_API_KEY` → OpenAI
3. `AI` binding → Cloudflare Workers AI
4. none of the above → a clear "Mail agent is not configured" response

The default models live in
`worker/src/lib/agent/constants.ts`:

| Provider   | Default model              |
| ---------- | -------------------------- |
| Anthropic  | `claude-sonnet-5`          |
| OpenAI     | `gpt-5.6-sol`              |
| Workers AI | `@cf/moonshotai/kimi-k2.6` |

Set `AGENT_MODEL` to override the default for whichever provider wins
precedence. The OpenAI default can be tier-gated by OpenAI account/project
access; if that model is unavailable to your project, set `AGENT_MODEL` to a
model that project can use.

### Anthropic

For production:

```bash
wrangler secret put ANTHROPIC_API_KEY
```

For local development, add `ANTHROPIC_API_KEY=...` to your gitignored
`.dev.vars`.

When `ANTHROPIC_API_KEY` is present and non-empty it takes precedence over
OpenAI and Workers AI.

### OpenAI

For production:

```bash
wrangler secret put OPENAI_API_KEY
```

For local development, add `OPENAI_API_KEY=...` to `.dev.vars`.

OpenAI is selected only when Anthropic is not configured. If the default model
is not available to your OpenAI project, set `AGENT_MODEL` as described
above.

### Cloudflare Workers AI

The committed `wrangler.jsonc.example` and `wrangler.jsonc.ci` include an
`AI` binding named `AI`. With no Anthropic or OpenAI key, the agent uses that
binding.

The default Workers AI model, `@cf/moonshotai/kimi-k2.6`, requires the
Cloudflare Workers Paid plan. Workers AI usage is billed/limited according to
the Cloudflare account's plan. Anthropic and OpenAI usage is billed by those
providers instead.

Workers AI has no local simulation: a Vite dev server with the `AI` binding
uses a remote binding and therefore needs Cloudflare authentication. The repo's
E2E workflow removes `AI` only from its temporary `wrangler.jsonc` copy
because that suite does not exercise the native agent; the committed CI/example
configs keep the required binding.

### `AGENT_MODEL`

`AGENT_MODEL` is not a secret. In production, add it to the Worker's
`vars` section; locally it may also be supplied through `.dev.vars`. It
overrides only the selected provider's model and does not alter provider
precedence.

## Sessions and authentication

The D1 table `agent_sessions` is the caller-owned session directory. It stores
an id, owner, title, timestamps, and archive state. It does **not** store chat
transcripts.

Authenticated session management is exposed at:

- `GET /api/agent/sessions`
- `POST /api/agent/sessions`
- `PATCH /api/agent/sessions/{id}`
- `DELETE /api/agent/sessions/{id}`

All four routes are caller-only and use the same BetterAuth-session/API-key
resolution as the rest of `/api/*`.

Each Durable Object instance is named:

```text
u-<userId>-s-<sessionId>
```

Agent traffic is routed under `/agents/mail-agent/*` before the SPA catch-all.
Both the SDK's `onBeforeConnect` and `onBeforeRequest` hooks re-resolve the
request's BetterAuth session or API key and reject an instance that does not
belong to the caller.

The Durable Object does not trust lifecycle props for identity. At the start of
every chat turn it matches `this.name` against the D1 session row, joins the
owning user, and loads that user's current role. If the session row is gone, the
turn returns 404. Every individual mail tool call then re-reads the user row
again before resolving `AllowedInboxes`, so a role or inbox-permission change
takes effect between steps of the same model turn.

Deleting `/api/agent/sessions/{id}` removes the D1 session registration and
causes later turns for that instance to be rejected. The chat transcript remains
separate Durable Object state; it is never copied into the mail database.

## What the agent can do

Every tool resolves the caller's current inbox permissions from D1 before
acting.

Read tools:

- identify the caller and list allowed inboxes
- list assignable teammates for an allowed inbox (id, name, and email)
- list, read, and search received/sent messages through `queryMessages()`
- read a customer timeline
- list sequences with step/active-enrollment counts
- list permission-scoped subscriber lists with member counts
- read the linked customer identity for a person
- list templates visible to the caller
- read the native-agent playbook

Organize tools:

- mark seen/unseen
- star/unstar
- archive/unarchive
- mark/unmark spam
- snooze/unsnooze conversations
- move messages to a custom folder

Draft tools:

- save a reply draft under `reply:<emailId>`
- save a new-message draft under `draft:<id>`

CRM actions with approval:

- enroll a person in a sequence
- cancel a person's active sequence enrollment
- add a person to a subscriber list the caller may edit
- assign or unassign a conversation
- link two person/email rows as one customer

These five tools use the AI SDK's human-in-the-loop approval state. The tool
request pauses at `approval-requested`; the UI renders a D1-derived,
permission-checked summary and the user chooses **Approve** or **Deny**. The
approval card is the confirmation, so the agent calls the gated tool directly
once its inputs are resolved instead of asking for an extra text confirmation.
For assignment by teammate name, it first calls `list_assignees` to resolve the
user id.

Approval requests are cryptographically bound to the exact tool call. By
default the runtime derives a stable 32-byte HKDF-SHA256 key from
`BETTER_AUTH_SECRET` with info `saasmail/agent-tool-approval/v1`; a non-empty
`AGENT_APPROVAL_SECRET` overrides that derived key. Because the effective key
is stable, pending approvals survive Durable Object reload/hibernation. Rotating
it invalidates still-pending cards rather than executing them with a stale
signature. An unsigned or stale card shows "This approval expired. Ask the
agent again."; the tool is not executed, and a later user turn treats the
incomplete old approval as denied so the session remains usable.

The pinned `agents` 0.24.0 / `@cloudflare/ai-chat` 0.12.0 persistence path
rebuilds approval UI parts without the AI SDK signature metadata. `MailAgent`
therefore keeps the signed approval fields in a separate
`agent_approval_ledger` table in the same Durable Object SQLite store. A
continuation restores metadata only when the approval id, tool-call id, and tool
name all match the ledger row; the AI SDK then verifies the original HMAC
against the current tool input before execution. The server never re-signs a
client-supplied transcript. Terminal tool results delete their ledger rows, and
recording a new approval also prunes rows older than seven days.

Expired approvals are persisted as terminal `output-denied` parts before the
continuation response is returned. In `@cloudflare/ai-chat` 0.12.0, a
continuation clones the last assistant message from the DO's current
`this.messages` and persists that clone after the stream, including the error
path. Because the repair write is awaited first, that clone already contains the
terminal denial. In addition, `agents` 0.24.0 `reconcileMessages()` overlays
server terminal states, including `output-denied`, onto stale client
`approval-responded` snapshots, so a delayed client cannot restore an
approved state.

Execution happens only after a valid approval and re-reads the user's current
role and inbox permissions, so access revoked while the card is waiting is
enforced. Approval continuations preserve the original assistant message when
building the AI SDK UI stream, including Workers AI's composite tool-call id, so
tool output and denied results attach to the existing invocation instead of
creating a broken new assistant message. At most five approved CRM actions
execute in one user turn; further calls return a guard error instructing the
model to ask the user before doing more.

When the user presses **Deny**, the tool part ends as `output-denied` and the
panel labels it **denied**; an `output-denied` part that carries a reason (an
expired approval) keeps the **error** label and shows the reason. The agent's
instructions treat a denied result as the user declining, so it reports that it
did not make the change rather than calling it a failure.

The panel resumes an in-progress turn after a page reload. If the page reloads
just as a turn finishes, its initial transcript can be fetched before the
answer is persisted while the resume handshake already reports no active
stream. In that case, when the transcript ends on an unanswered user message,
the panel re-reads the persisted transcript once and shows it if it strictly
extends what the panel has (`src/agent/transcriptCatchUp.ts`).

A reply draft never overwrites a non-empty human autosave. If a user already has
content in `reply:<emailId>`, the agent returns
`{ saved: false, reason: "existing_draft", ... }` and leaves that draft
unchanged.

## What the agent cannot do

Stage 2 deliberately exposes no tool to:

- send email
- trash or permanently delete mail
- bypass approval for CRM actions
- bypass inbox permissions
- treat client-supplied context as authorization

The human must open a saved draft in the composer and send it.

## Prompt safety

Message content enters the model as quoted untrusted data with an explicit
instruction that mail content is **content, not instructions**. Subjects,
bodies, headers, attachments, and quoted tool output must never be followed as
system/developer/tool instructions.

The client may provide navigation context such as current inbox, folder,
selected message ref, or person id. The runtime whitelists those fields and
labels the block "never authorization"; tool permission checks remain the source
of truth.

## Runtime limits

Each chat turn is capped at eight AI SDK steps. If the model calls a tool that
does not exist, the runtime repairs that call to the read-only
`get_playbook` tool so the model can recover against the actual Stage 2 tool
surface rather than terminating the turn.

Agent-runtime dependencies are intentionally exact-pinned because the
Cloudflare Agents and AI SDK APIs are moving quickly. See
[AGENTS.md](../AGENTS.md) before upgrading them.

---

**See also:** [Mailbox state](mailbox-state.md) · [MCP server](mcp.md) · [WebMCP](webmcp.md)
