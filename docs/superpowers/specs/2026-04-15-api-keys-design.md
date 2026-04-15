# API Keys for cmail

## Overview

Allow each user to generate a personal API key for programmatic access to cmail. Keys authenticate via `Authorization: Bearer sk_...` and grant full access to everything the authenticated user can do. Each user has at most one key, which can be regenerated or revoked. A new top-level "API" page is accessible from the header navigation.

## Database

New table `apiKeys` in `worker/src/db/api-keys.schema.ts`:

| Column      | Type    | Constraints                                    |
| ----------- | ------- | ---------------------------------------------- |
| `id`        | text    | Primary key (nanoid)                           |
| `userId`    | text    | FK → users (cascade on delete), unique         |
| `keyHash`   | text    | SHA-256 hash of the full key                   |
| `keyPrefix` | text    | First 8 chars for display (e.g., `sk_a1b2...`) |
| `createdAt` | integer | Unix timestamp                                 |

- One key per user enforced by unique constraint on `userId`.
- Full key is never stored — only the hash.
- Key format: `sk_<32 random hex chars>` (40 chars total).

## API Routes

New router mounted at `/api/api-keys`, all requiring session auth:

### `POST /api/api-keys` — Generate key

- If a key already exists for the user, delete it first (regenerate).
- Generate a random key (`sk_<random>`), hash it, store hash + prefix.
- Return the full key in the response (only time it's shown).
- Response: `{ key: "sk_...", prefix: "sk_a1b2...", createdAt: 1234567890 }`

### `GET /api/api-keys` — Get key info

- Return the key prefix and creation date, or null if no key exists.
- Response: `{ prefix: "sk_a1b2...", createdAt: 1234567890 }` or `{ key: null }`

### `DELETE /api/api-keys` — Revoke key

- Delete the user's key.
- Response: `{ success: true }`

## Auth Middleware

Update the existing auth middleware in `worker/src/index.ts`:

1. If request has a valid session cookie → proceed as today.
2. Else if request has `Authorization: Bearer sk_...` header → hash the token, look up in `apiKeys` table by `keyHash`, resolve the associated user, set `c.set("user", user)`.
3. Else → 401 Unauthorized.

All existing `/api/*` routes automatically work with API keys — no per-route changes.

## Frontend

### New page: `/api` (`src/pages/ApiPage.tsx`)

Accessible from header navigation, next to "Templates".

**States:**

1. **No key:** "Generate API Key" button + usage instructions.
2. **Key just generated:** Full key in a copyable field, warning "This key won't be shown again", "Done" button.
3. **Existing key:** Key prefix (`sk_a1b2...`), creation date, "Regenerate" button (with confirmation dialog), "Revoke" button (with confirmation dialog).

**Usage instructions section:** Shows example curl command:

```
curl -H "Authorization: Bearer sk_..." https://your-domain/api/senders
```

### Routing

Add `/api-keys` route in `src/App.tsx` pointing to `ApiPage`, protected by `AuthGuard`.

### Navigation

Add "API" link in the inbox header (`src/pages/inbox/components/inbox-header.tsx`), next to "Templates".

### API client functions

Add to `src/lib/api.ts`:

- `generateApiKey()` — POST `/api/api-keys`
- `fetchApiKeyInfo()` — GET `/api/api-keys`
- `revokeApiKey()` — DELETE `/api/api-keys`
