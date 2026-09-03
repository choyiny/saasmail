[saasmail](../README.md) › [Docs](README.md) › **MCP server**

# MCP server (AI assistant access)

Connect Claude, or any other MCP client, directly to your inbox. saasmail
exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at
`/mcp` over streamable HTTP, secured with OAuth 2.1.

There is nothing to pre-register. The client discovers the authorization
server, registers itself (RFC 7591), and sends you through a normal browser
login plus a consent screen listing exactly what it is asking for. Approve it
and the client gets a scoped token.

For the in-page variant that runs in the browser tab instead, see
[WebMCP](webmcp.md).

## Connecting a client

**Claude Code**

```bash
claude mcp add --transport http saasmail https://your-domain.com/mcp
```

Then run `/mcp` inside Claude Code and choose `saasmail` to finish the browser
login. Add `--scope user` to the command to make the connection available in
every project rather than only the current one.

**claude.ai** — Settings → Connectors → add a custom connector pointing at
`https://your-domain.com/mcp`. On Team and Enterprise plans, only admins can
add connectors.

**Any other MCP client** — point it at `https://your-domain.com/mcp` and choose
streamable HTTP as the transport. Clients configured by file usually want:

```json
{
  "mcpServers": {
    "saasmail": {
      "type": "http",
      "url": "https://your-domain.com/mcp"
    }
  }
}
```

`"streamable-http"` is accepted as a synonym for `"http"`.

## Naming the connection

The server identifies itself with this instance's **brand name** (Settings →
brand name, the `brand_name` app setting; defaults to `saasmail`), both in the
MCP handshake and as `resource_name` in its OAuth discovery document. Set a
distinct brand name on each instance and clients that name a connector from
discovery will keep two saasmail deployments apart.

Clients that ask _you_ for the name still win: the `saasmail` in
`claude mcp add … saasmail …` and the key in the `mcpServers` block above are
local labels. Change those too when you connect more than one instance.

## Prerequisites

Two settings (see [Configuration](configuration.md#devvars)) must be right, or
the handshake fails in ways that are hard to read:

- **`BASE_URL` must exactly match the URL you hand the client** — same scheme
  and host, no trailing slash. Every OAuth identifier derives from it, and a
  token's audience is fixed at the moment it is issued. Connect to
  `https://www.example.com/mcp` while `BASE_URL` says `https://example.com` and
  tokens get minted for one identity and verified against another, so every
  call returns 401.
- **`BETTER_AUTH_SECRET` must be set.** It protects the OAuth signing keys.

To check the endpoint is reachable and discovery is wired up before involving a
client at all:

```bash
curl https://your-domain.com/.well-known/oauth-protected-resource/mcp
```

That returns the resource metadata (audience, authorization server, supported
scopes). An unauthenticated `POST /mcp` should return `401` with a
`WWW-Authenticate` header pointing back at that same document — that is the
handshake working, not an error.

## Scopes

Three scopes gate what a connected client may do:

| Scope          | Grants                                                             |
| -------------- | ------------------------------------------------------------------ |
| `email:read`   | `whoami`, `list_people`, `get_person`, `list_emails`, `read_email` |
| `email:send`   | `send_template`, `enroll_sequence`                                 |
| `email:manage` | `mark_read`, `delete_email`                                        |

**Access is scoped to the connecting user.** A client acting for a member with
access to one inbox sees only that inbox — the same permission model as the web
UI and the HTTP API, enforced by the same code. Admins see everything. A passkey
is required, the same as for the web API.

**Prefer `email:read` alone.** An assistant connected to a mailbox reads
attacker-authored content by definition — anyone can email you. Granting
`email:send` or `email:manage` alongside it means a message in your inbox can
try to instruct the assistant to mail your data somewhere or delete it. The
consent screen flags those two scopes for this reason, and `delete_email` is
permanent (there is no trash). Grant them only to clients you actually trust.

**Revoking access.** Admins can list connected OAuth clients and cut them off at
**Settings → OAuth apps** (`GET /api/oauth-apps`, `DELETE /api/oauth-apps/{clientId}`).
Revocation takes effect on the client's next call: the MCP endpoint checks the
client on every request, so a revoked connection cannot keep working until its
token expires. Banning a user has the same immediate effect.

Any client can register itself (that is how MCP connectors work), so the list is
also where you spot one you don't recognise.

---

**See also:** [WebMCP](webmcp.md) · [Users and API keys](users-and-api-keys.md) · [Configuration](configuration.md)
