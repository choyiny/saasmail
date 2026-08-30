# Agent Entrypoint Parity — Capability-Tier Policy

**Status:** Design / policy (this round is documentation only — no code).
**Date:** 2026-08-30
**Author:** i@choy.in (+ Claude)

## 1. Context & goal

saasmail exposes its capabilities to autonomous and semi-autonomous agents through **three
distinct entrypoints**, each with its own auth pipeline and its own (accidentally divergent)
subset of features:

1. **Direct HTTP API** — the `/api/*` OpenAPI surface, authenticated by a better-auth session
   cookie (the SPA) or an `sk_` API-key bearer token (integrations). This is the **superset**:
   every capability the product has is reachable here.
2. **Server-side MCP server** — a Streamable-HTTP MCP endpoint at `/mcp`, authenticated by OAuth
   2.0 bearer JWTs with `email:read` / `email:send` / `email:manage` scopes. 12 tools today.
3. **WebMCP (browser)** — in-page tools registered via `navigator.modelContext` (with the
   `@mcp-b/global` polyfill), authenticated by the ambient logged-in session cookie. 19 tools
   today, but every send/destructive action is staged behind a human confirmation.

These three surfaces drifted apart because each was built against its own need. The result is a
patchwork: MCP can _send_ a template but can't _discover_ which templates exist; WebMCP can
_discover_ templates and sequences but can't _act_ on them autonomously; the direct API can do
everything but grants an `sk_` key the full role of its owner with no scoping.

**Goal (target state): full convergence.** Every `/api/*` capability has an equivalent function
on **both** MCP and WebMCP, governed by a single four-tier scope model, with unified credentials
across the API and MCP surfaces.

This document defines that policy and maps every capability to its tier and its per-surface
current-vs-target status. It is the reference the follow-up implementation rounds build against.

## 2. Tier model

Four capability tiers, reusing the scope strings already defined in
`worker/src/auth/scopes.ts:8-12` and adding one:

| Tier       | Scope string   | Authorizes                                                                                                                                                                                                                  | New?     |
| ---------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Read**   | `email:read`   | Discovery + reading: identity, inboxes, contacts, conversations, emails, search, templates, sequences, drafts, outbox, stats. No side effects.                                                                              | existing |
| **Send**   | `email:send`   | Outbound effects: send raw/template email, reply, enroll in sequence.                                                                                                                                                       | existing |
| **Manage** | `email:manage` | Mutating state without new outbound mail: mark read/unread, delete email, reassign, template CRUD, sequence CRUD, enrollment cancel, draft CRUD, outbox retry/cancel, contact delete, notifications, self-service API keys. | existing |
| **Admin**  | `email:admin`  | Instance administration: invites, users, roles, inboxes + assignments, blocklist, suppressions, webhooks, oauth-apps, instance settings. Admin-role holders only.                                                           | **NEW**  |

Scopes are cumulative in intent but enforced independently: a token/key carries an explicit set,
and each capability requires exactly one tier. `email:admin` is only ever granted to a principal
whose underlying user has the `admin` role — the scope is necessary but not sufficient.

## 3. Governing principles

Each is a stated policy with its rationale. Together they define "target state."

**P1 — Four tiers, one vocabulary.** All three surfaces authorize against the same
`email:read|send|manage|admin` scopes. The direct API stops inheriting the owner's full role;
MCP and WebMCP stop inventing per-surface rules. _Rationale: one mental model, one place to reason
about least privilege._

**P2 — Every endpoint has an MCP function.** For every `/api/*` capability there is an equivalent
MCP tool at the same tier, **including the admin tier** (behind `email:admin`). MCP becomes a
complete mirror of the API, not a curated subset. _Rationale: agents shouldn't hit a capability
cliff where they must fall back to raw HTTP._

**P3 — WebMCP reaches functional parity; autonomy is configurable per capability.** WebMCP exposes
the same capability set as MCP. Autonomy is **off by default and opt-in per tier**: a user can
enable autonomous send / reply / enroll, but destructive capabilities (delete / reassign / CRUD)
and the admin tier stay confirm-gated even then. Read stays always-autonomous. _Rationale: full
functional convergence without accepting R1's blast radius by default. Amended from blanket
autonomy after weighing R1._

**P4 — Credential unification.** An `sk_` API key is a valid MCP bearer token. A single credential
authenticates against both `/api/*` and `/mcp`, carrying the same scope set on both. _Rationale:
integrators manage one secret, not two, and the scope grant is identical wherever it's presented._

**P5 — API keys honor tiers.** An `sk_` key carries an explicit scope set (`email:read|send|manage|admin`)
chosen at creation, instead of silently inheriting its owner's entire role. Read-only and send-only
keys become expressible. _Rationale: least privilege for integrations; today a leaked key = full
account compromise._

**P6 — Enforcement lives in the shared service layer.** Scope + inbox-scoping checks stay in the
shared query/service functions (`lib/queries/*`, `lib/send-email.ts`, etc.) that back all surfaces,
not re-implemented per entrypoint. _Rationale: MCP tools already call the same service functions as
the routers (confirmed in the audit); parity must not fork that._

## 4. Master capability matrix

Legend — **✅** present & autonomous · **🔶** present but gated/partial · **❌** absent ·
**→** target action. Every capability's target is "✅ on all three surfaces" unless the notes say
otherwise; cells already ✅ need no work.

### Read tier (`email:read`)

| Capability                       | API | MCP                      | WebMCP                                  | Gap → target                                         |
| -------------------------------- | --- | ------------------------ | --------------------------------------- | ---------------------------------------------------- |
| Identity / whoami                | ✅  | ✅ `whoami`              | ✅ `whoami`                             | —                                                    |
| List inboxes / sender identities | ✅  | 🔶 (inside `whoami`)     | ✅ `list_inboxes`                       | MCP: dedicated `list_inboxes` tool                   |
| List contacts (grouped / search) | ✅  | ✅ `list_people`         | ✅ `list_contacts`/`list_conversations` | —                                                    |
| Get contact + counts             | ✅  | ✅ `get_person`          | ✅ `get_contact`                        | —                                                    |
| List emails by person            | ✅  | ✅ `list_emails`         | ✅ `list_emails`                        | —                                                    |
| List emails by conversation      | ✅  | 🔶 (person-only)         | ✅ `list_emails(conversationId)`        | MCP: accept conversationId                           |
| Read full email                  | ✅  | ✅ `read_email`          | ✅ `read_email`                         | —                                                    |
| Search mail                      | ✅  | ✅ `search_emails`       | ✅ `search_emails`                      | —                                                    |
| Download attachment bytes        | ✅  | ❌                       | ❌ (metadata only)                      | MCP + WebMCP: `get_attachment`                       |
| Inline attachment                | ✅  | ❌                       | ❌                                      | MCP + WebMCP: expose or fold into `get_attachment`   |
| List templates                   | ✅  | ❌                       | ✅ `list_templates`                     | **MCP: `list_templates`** (blocks `send_template`)   |
| Get template + variables         | ✅  | ❌                       | ✅/🔶 `get_template`                    | **MCP: `get_template`**                              |
| List sequences                   | ✅  | ❌                       | ✅ `list_sequences`                     | **MCP: `list_sequences`** (blocks `enroll_sequence`) |
| Get sequence                     | ✅  | ❌                       | ❌                                      | MCP + WebMCP: `get_sequence`                         |
| Get person enrollment            | ✅  | ❌                       | ❌                                      | MCP + WebMCP: `get_enrollment`                       |
| List sequence enrollments        | ✅  | ❌                       | ❌                                      | MCP + WebMCP: `list_enrollments`                     |
| Get draft                        | ✅  | ❌                       | ❌                                      | MCP + WebMCP: `get_draft`                            |
| Outbox count / list              | ✅  | ❌                       | ❌                                      | MCP + WebMCP: `list_outbox`                          |
| Instance stats                   | ✅  | 🔶 (partial in `whoami`) | ✅ (`fetchStats`)                       | MCP: `get_stats`                                     |

### Send tier (`email:send`)

| Capability          | API | MCP                       | WebMCP                                  | Gap → target                     |
| ------------------- | --- | ------------------------- | --------------------------------------- | -------------------------------- |
| Send raw email      | ✅  | ✅ `send_email`           | 🔶 `compose_email` (draft, human sends) | WebMCP: autonomous send (P3)     |
| Reply (threaded)    | ✅  | ✅ `reply_email`          | 🔶 `reply_email` (human-confirmed)      | WebMCP: autonomous reply (P3)    |
| Send template       | ✅  | ✅ `send_template`        | 🔶 `compose_from_template` (draft)      | WebMCP: autonomous send (P3)     |
| Attachments on send | ✅  | ❌ (`files:[]` hardcoded) | ❌                                      | MCP + WebMCP: accept attachments |
| Enroll in sequence  | ✅  | ✅ `enroll_sequence`      | 🔶 `enroll_in_sequence` (dialog)        | WebMCP: autonomous enroll (P3)   |

### Manage tier (`email:manage`)

| Capability                          | API | MCP                 | WebMCP                        | Gap → target                      |
| ----------------------------------- | --- | ------------------- | ----------------------------- | --------------------------------- |
| Mark read/unread (single)           | ✅  | ✅ `mark_read`      | ✅ `mark_read`/`mark_unread`  | —                                 |
| Bulk mark emails                    | ✅  | ❌                  | ❌                            | MCP + WebMCP: bulk variant        |
| Bulk mark people/conversations read | ✅  | ❌                  | ❌                            | MCP + WebMCP: bulk variant        |
| Patch single email flags (archive)  | ✅  | 🔶 (read flag only) | 🔶                            | MCP + WebMCP: full flag patch     |
| Delete email                        | ✅  | ✅ `delete_email`   | 🔶 `delete_email` (confirmed) | WebMCP: autonomous per P3         |
| Reassign email → person             | ✅  | ❌                  | ❌                            | MCP + WebMCP: `reassign_email`    |
| Delete contact                      | ✅  | ❌                  | ❌                            | MCP + WebMCP: `delete_person`     |
| Template create/update/delete       | ✅  | ❌                  | ❌                            | MCP + WebMCP: template CRUD       |
| Sequence create/update/delete       | ✅  | ❌                  | ❌                            | MCP + WebMCP: sequence CRUD       |
| Cancel enrollment                   | ✅  | ❌                  | ❌                            | MCP + WebMCP: `cancel_enrollment` |
| Draft save/delete                   | ✅  | ❌                  | ❌                            | MCP + WebMCP: draft write/delete  |
| Outbox retry / cancel               | ✅  | ❌                  | ❌                            | MCP + WebMCP: outbox actions      |
| Notifications / web push            | ✅  | ❌                  | ❌                            | **Out of scope for agents** (D1)  |
| Self-service API-key mgmt           | ✅  | ❌                  | ❌                            | **Excluded from agents** (D2)     |

### Admin tier (`email:admin`, admin role only)

| Capability                 | API | MCP | WebMCP | Gap → target              |
| -------------------------- | --- | --- | ------ | ------------------------- |
| Invites create/list/revoke | ✅  | ❌  | ❌     | MCP + WebMCP: admin tools |
| Users list / role / delete | ✅  | ❌  | ❌     | MCP + WebMCP: admin tools |
| Instance settings patch    | ✅  | ❌  | ❌     | MCP + WebMCP: admin tools |
| Inboxes CRUD + assignments | ✅  | ❌  | ❌     | MCP + WebMCP: admin tools |
| Blocklist CRUD + purge     | ✅  | ❌  | ❌     | MCP + WebMCP: admin tools |
| Suppressions CRUD          | ✅  | ❌  | ❌     | MCP + WebMCP: admin tools |
| Webhooks get/set/test      | ✅  | ❌  | ❌     | MCP + WebMCP: admin tools |
| OAuth-apps list/revoke     | ✅  | ❌  | ❌     | MCP + WebMCP: admin tools |

## 5. Gap summary per surface

**MCP — the big lift is discovery + management + admin.** It already has autonomous read/send.
It needs, in rough priority order:

1. **Read/discovery gaps that block existing tools:** `list_templates`, `get_template`,
   `list_sequences`, `get_sequence` — today `send_template` and `enroll_sequence` require the agent
   to guess slugs/ids.
2. **Attachments:** unblock `files:[]` on send; add `get_attachment` for reading bytes.
3. **Remaining read:** enrollments, drafts, outbox, dedicated inboxes/stats.
4. **Manage tier:** template/sequence CRUD, bulk marks, reassign, delete contact, draft write,
   outbox retry/cancel, enrollment cancel.
5. **Admin tier:** new `email:admin` scope + a full admin toolset, admin-role gated.

**WebMCP — the big lift is autonomy + the same management/admin breadth.** It already has the widest
_read_ surface. It needs:

1. **Configurable autonomy (P3):** let `compose_email`, `compose_from_template`, `reply_email`,
   `enroll_in_sequence` run autonomously **when the user opts in per tier** (off by default);
   `delete_email` and other destructive/admin actions stay confirm-gated regardless. Subject to
   R1's remaining mitigations.
2. **Attachments** on send + `get_attachment`.
3. **Manage tier** (browser session) — same CRUD/bulk breadth MCP needs. **Admin tier deferred**
   (D3).

**Direct API — the lift is authorization granularity, not features.** It has every capability. It
needs P4/P5: scoped `sk_` keys, and those keys accepted as MCP bearer tokens.

## 6. Credential-unification design (P4 + P5)

Today the two pipelines are fully separate:

- **API keys:** `Authorization: Bearer sk_…` → SHA-hashed → matched against `apiKeys.keyHash` →
  resolves owning user, `authMethod="apiKey"`, **no scopes, full owner role**
  (`worker/src/index.ts:174-199`).
- **MCP tokens:** `Authorization: Bearer <JWT>` → offline JWS verification against better-auth JWKS,
  issuer/audience checks, live revocation checks, **passkey required**, scopes parsed from the JWT
  (`worker/src/mcp/http.ts:87-171`).

**Target design (to be detailed in the implementation round):**

1. The `/mcp` auth middleware detects credential shape. A token beginning `sk_` is resolved via the
   API-key path; a JWT continues through the OAuth path.
2. **Scopes for `sk_` keys:** stored on the `apiKeys` row (P5), read directly — no JWT claims. The
   same scope set gates `/api/*` and `/mcp`.
3. **Passkey-gate reconciliation (R2):** MCP currently rejects any principal without a passkey
   because it grants more than the web API. Once the API grants the _same_ capabilities under the
   same scopes, that asymmetry is gone — but the gate must be resolved _deliberately_. Options to
   decide in implementation: (a) require the key's owner to have a passkey at key-creation time;
   (b) drop the MCP passkey gate now that scopes bound the grant; (c) mark keys as
   "MCP-eligible" only when minted under a passkey session. **Not decided here — flagged.**
4. Inbox-scoping (`resolveAllowedInboxes`) and live revocation (disabled key, banned/deleted user)
   apply identically regardless of credential shape.

## 7. Risks & open questions

**R1 — WebMCP autonomy × session-cookie auth = a prompt-injection blast radius.** An in-page agent
that reads attacker-controlled email content _and_ can autonomously send/delete/administer, authed
by the ambient session cookie, is a materially larger attack surface than today's confirm-gated
design. **Resolved (P3 amended):** autonomy is off by default and opt-in per tier; destructive and
admin capabilities stay confirm-gated on WebMCP regardless. Remaining mitigations to carry into the
WebMCP round: require a recent user gesture / same-origin assertion before autonomous writes;
rate-limit autonomous sends; surface a clear indicator when autonomy is enabled.

**R2 — `sk_` key as MCP token bypasses the passkey gate.** See §6.3 — must be resolved explicitly,
not inherited by accident.

**R3 — Admin capabilities on agent surfaces widen impact of any credential leak.** An `email:admin`
scope means a leaked/injected agent can create users or edit webhooks. Mitigation: `email:admin`
never granted by default; separate opt-in at key/token creation; consider keeping admin _mutations_
confirm-gated on WebMCP even under P3.

## 7a. Resolved decisions

**D1 (was Q1) — Notifications / web-push are out of scope for agents.** They're SPA-oriented
(subscription lifecycle for a browser). Exposed on the direct API only; not mirrored to MCP,
irrelevant to WebMCP.

**D2 (was Q2) — Self-service API-key management is excluded from both agent surfaces.** An agent
minting or rotating its own credentials is a privilege-escalation footgun. Key management stays
session + direct-API only.

**D3 (was Q3) — WebMCP admin is deferred.** Admin tools land on **MCP first** (under `email:admin`).
WebMCP admin is not built until the R1/R3 mitigations are in place; under P3, admin stays
confirm-gated on WebMCP even after that.

## 8. Phased roadmap (follow-up rounds)

Each phase is its own spec → plan → implementation cycle.

1. **Tier foundation.** Add `email:admin` to `scopes.ts` and `OAUTH_SCOPES`; add a scope column to
   `apiKeys`; scope enforcement plumbed through the shared service layer (P1, P6). No new tools yet.
2. **MCP read/discovery parity.** `list_templates`, `get_template`, `list_sequences`,
   `get_sequence`, enrollments, drafts, outbox, `get_stats`, `list_inboxes` — closes the cliffs
   that block today's `send_template` / `enroll_sequence`.
3. **Attachments everywhere.** Unblock `files:[]` on MCP send; `get_attachment` on MCP + WebMCP.
4. **Credential unification.** `sk_` keys carry scopes (P5); `/mcp` accepts `sk_` keys (P4);
   resolve R2. Scoped-key creation UI.
5. **MCP manage tier.** Template/sequence CRUD, bulk marks, reassign, delete contact, draft write,
   outbox actions, cancel enrollment.
6. **MCP admin tier.** `email:admin` toolset, admin-role gated (R3).
7. **WebMCP convergence.** Configurable per-capability autonomy (P3, off by default, with R1
   mitigations), then the manage-tier breadth. WebMCP admin deferred (D3); destructive/admin stay
   confirm-gated. Sequenced last because it carries the most risk.

---

### Appendix — source references

- Direct API routes & auth: `worker/src/index.ts` (mounts 231-282; auth 159-228), routers under
  `worker/src/routers/`.
- MCP server & tools: `worker/src/mcp/server.ts` (tools), `worker/src/mcp/http.ts` (auth/transport),
  `worker/src/mcp/resource.ts` (`/mcp` path, audiences).
- Scopes: `worker/src/auth/scopes.ts:8-12`; OAuth provider `worker/src/auth/index.ts:60-75`.
- WebMCP: `src/webmcp/` — `registerTools.tsx` (assembly), `tools/read.ts`, `tools/actions.ts`,
  `bridge.tsx` (confirmation staging), `runtime.ts` (polyfill); mounted in
  `src/components/DashboardLayout.tsx:36-37`; feature flag `worker/src/routers/bootstrap-router.ts:64-73`.
