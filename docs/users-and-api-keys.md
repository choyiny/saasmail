[saasmail](../README.md) › [Docs](README.md) › **Users and API keys**

# Users and API keys

## User management

Admin-controlled onboarding via one-time invite links. New members sign up with email + password, and can register a passkey for passwordless login on subsequent sessions. Roles: `admin` (full access + user management) and `member` (scoped by inbox assignment).

Inbox assignment is what a member's access actually derives from — see
[Multi-inbox with team permissions](inboxes.md#multi-inbox-with-team-permissions).
The same scoping is enforced for the HTTP API, the [MCP server](mcp.md), and
[WebMCP](webmcp.md), by the same code.

## API keys

Issue scoped API keys for programmatic access to send email, manage templates, enroll contacts in sequences, and query inbox data. Keys are hashed at rest and follow the `sk_…` format.

Pass one as `Authorization: Bearer sk_…`. The interactive explorer at
`/swagger-ui` on your deployment documents every route a key can reach.

---

**See also:** [MCP server](mcp.md) for OAuth-based AI assistant access · [Webhooks](webhooks.md) · the `/use-saasmail` Claude Code skill
