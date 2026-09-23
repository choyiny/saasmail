[saasmail](../README.md) › [Docs](README.md) › **Native mail agent**

# Native mail agent

Stage 2 adds a backend runtime for a native in-app mail agent. The runtime is
implemented as a Cloudflare Durable Object using the Cloudflare `agents` SDK
and `@cloudflare/ai-chat`; chat transcripts live in that Durable Object's
SQLite storage. Mail data remains in D1, and every mail read or mutation goes
through the same permission-scoped services used elsewhere in saasmail.

There is no native agent UI in Stage 2a. This page covers the backend runtime,
provider setup, sessions, authentication, and the capability boundary that
future UI work connects to.

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
- list, read, and search received/sent messages through `queryMessages()`
- read a customer timeline
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

A reply draft never overwrites a non-empty human autosave. If a user already has
content in `reply:<emailId>`, the agent returns
`{ saved: false, reason: "existing_draft", ... }` and leaves that draft
unchanged.

## What the agent cannot do

Stage 2 deliberately exposes no tool to:

- send email
- trash or permanently delete mail
- enroll a contact into a sequence
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
