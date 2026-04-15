# Email Templates Design

## Overview

Add API-managed email templates identified by a slug, with `{{variable}}` interpolation, sent via the existing Resend integration. Templates are transactional/automated — no UI, API-only.

## Data Model

New `email_templates` table in D1:

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | text | PK (nanoid) |
| `slug` | text | unique, not null |
| `name` | text | not null |
| `subject` | text | not null |
| `bodyHtml` | text | not null |
| `createdAt` | integer | not null, default now |
| `updatedAt` | integer | not null, default now |

- `slug` is the lookup key for sending (e.g., `welcome-email`, `order-confirmation`).
- `subject` and `bodyHtml` both support `{{variableName}}` interpolation.

## API Endpoints

All endpoints are auth-protected and follow existing Hono + Zod OpenAPI patterns.

### CRUD

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/email-templates` | Create a template |
| `GET` | `/api/email-templates` | List all templates |
| `GET` | `/api/email-templates/:slug` | Get template by slug |
| `PUT` | `/api/email-templates/:slug` | Update template |
| `DELETE` | `/api/email-templates/:slug` | Delete template |

#### Create/Update Request Body

```json
{
  "slug": "welcome-email",
  "name": "Welcome Email",
  "subject": "Welcome, {{name}}!",
  "bodyHtml": "<h1>Hello {{name}}</h1><p>Thanks for joining.</p>"
}
```

For updates, `slug` in the body is omitted (identified by URL param). All fields optional on update.

### Send

`POST /api/email-templates/:slug/send`

```json
{
  "to": "recipient@example.com",
  "variables": { "name": "Alice", "orderId": "12345" }
}
```

**Behavior:**
1. Look up template by slug (404 if not found).
2. Interpolate `{{variableName}}` in both `subject` and `bodyHtml` using provided variables.
3. Send via Resend using existing `RESEND_EMAIL_FROM` as the `from` address.
4. Record in `sent_emails` table with the rendered HTML and subject.
5. Return the sent email record.

Unmatched `{{variables}}` are left as-is in the output (forgiving behavior).

## Interpolation

Simple regex-based replacement: `/\{\{(\w+)\}\}/g` — replace each match with the corresponding value from the `variables` object, or leave unchanged if not provided.

No template engine dependency. No conditionals or loops.

## Integration

- **Resend:** Uses the same Resend client and `RESEND_EMAIL_FROM` env var as the existing send router.
- **sent_emails:** Sent templated emails are recorded in `sent_emails` with the rendered subject/body, the template slug is not tracked in `sent_emails` (keeps the table simple).
- **Auth:** All endpoints require authentication via the existing auth middleware.

## Out of Scope

- No UI for template management or sending.
- No variable schema or validation on template definition.
- No plain text version — HTML only.
- No template versioning or history.
