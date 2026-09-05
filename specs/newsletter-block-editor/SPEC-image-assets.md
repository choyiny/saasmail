# Spec: image-assets

> Module `image-assets` of [the newsletter block editor map](./README.md).
> Shared commands, structure, style, testing and boundaries live there.

## Objective

Newsletter images need **public, unauthenticated, cacheable, immutable** URLs.
Every existing image path in saasmail fails at least one of those:

| Existing path                   | Why it does not work for a newsletter                     |
| ------------------------------- | --------------------------------------------------------- |
| `TiptapEditor` base64 data URIs | Gmail strips them; the bytes are duplicated per recipient |
| `GET /api/attachments/{id}`     | Authenticated, inbox-scoped, `Cache-Control: private`     |
| `/{id}/inline`                  | Same auth scoping — a subscriber has no session           |

So this is a new surface, not a reuse. It has no dependency on the compiler:
the compiler emits whatever URL the document holds.

## Assumptions

1. R2 binding `R2` already exists (`wrangler.jsonc`, bucket
   `saasmail-attachments`). Newsletter assets share the bucket under a distinct
   key prefix rather than needing a second bucket.
2. Images only. No PDFs, no arbitrary downloads.
3. Upload is authenticated (an operator composing a template); serving is not.

## Data

```ts
// worker/src/db/newsletter-assets.schema.ts
export const newsletterAssets = sqliteTable("newsletter_assets", {
  id: text("id").primaryKey(), // 128-bit random, base32 — never sequential
  r2Key: text("r2_key").notNull(), // `newsletter-assets/{id}`
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  width: integer("width"),
  height: integer("height"),
  sha256: text("sha256").notNull(), // dedupe on re-upload of the same bytes
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});
```

The id is the URL. It must be unguessable, because the serve route has no
authorization — enumerable ids would make every subscriber's newsletter imagery
walkable. 128 bits of randomness, not a ULID, not a counter.

## Routes

**`POST /api/newsletter-assets`** — authenticated, **raw body bytes**.

> Changed from `multipart/form-data` during implementation. The CSV import at
> `lists-router.ts:934` already takes a raw `arrayBuffer()`, and multipart would
> add a parser for no gain: the declared part headers are attacker-controlled
> and get ignored in favour of magic bytes regardless.

- Accepts `image/png`, `image/jpeg`, `image/gif`, `image/webp`. **Allowlist,
  not a blocklist**, and the check is on sniffed magic bytes, not on the
  client-declared `Content-Type` or the filename extension.
- Max 5 MB per image.
- Computes SHA-256; an identical digest returns the existing row instead of
  storing a second copy.
- Returns `{ id, url, width, height }`.

**`GET /newsletter-images/{id}`** — public, unauthenticated. Mounted outside
`/api` so it sits outside the auth middleware rather than carving an exception
into it.

> **Not `/assets/n/{id}`, as originally specified.** Vite emits the SPA bundle
> to `dist/client/assets/`, so a router mounted at `/assets` would sit on top of
> the application's own JavaScript, with the winner decided by static-asset
> ordering. Caught before it shipped; the returned URL prefix is the
> `PUBLIC_ASSET_PATH` constant so the eventual move to a dedicated asset
> hostname stays a one-line change.

```
Content-Type:            <row.contentType>          # never sniffed from bytes at serve time
Content-Disposition:     inline
Cache-Control:           public, max-age=31536000, immutable
X-Content-Type-Options:  nosniff
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'
```

`404` for an unknown id, with no distinction between "never existed" and
"deleted" — the id is the only secret.

## The risk worth naming

Serving user-uploaded bytes from the application's own origin is a stored-XSS
vector: an attacker who gets an HTML or SVG payload served as a document from
`saasmail.example.com` runs script in that origin. Three controls, all required:

1. **Magic-byte allowlist on upload.** SVG is excluded deliberately — it is an
   XML document that can carry script, and no newsletter needs it.
2. **`nosniff` + a stored `Content-Type`** on serve, so a file that slipped
   through cannot be re-interpreted by the browser.
3. **`Content-Security-Policy: default-src 'none'`** on the response, so even a
   document that renders executes nothing.

A separate asset hostname would be the fourth and strongest control. It is out
of scope for v1 because it requires DNS the operator must configure, but the
serve route should be written so its base URL comes from config rather than
being derived from the request host — that is what makes the move cheap later.

## Lifecycle

**No garbage collection in v1**, stated as a decision rather than an oversight.
An asset referenced by a sent campaign must outlive the template that
introduced it: a subscriber opens the mail months later, and the campaign's
frozen `htmlSnapshot` still points at that URL. Reference-counting across live
templates _and_ every historical snapshot is real work for a small storage win.

Keila does track references by scanning `json_body` for file ids
(`test/keila/files/files_test.exs:55`). If we ever add GC, that is the shape:
scan block documents plus `campaigns.html_snapshot`, never delete anything
younger than the retention window.

Document the decision in `docs/newsletters.md` so operators know assets
accumulate.

## Success criteria

- [ ] Upload rejects a `.png`-named file whose magic bytes are SVG or HTML.
- [ ] Upload rejects >5 MB with `413`, not a truncated write.
- [ ] Re-uploading identical bytes returns the first id and writes no second R2 object.
- [ ] `GET /newsletter-images/{id}` succeeds with no session cookie and no API key.
- [ ] The response carries all five headers above, verified in a route test.
- [ ] An unknown id returns `404` with an empty body.
- [ ] Ids are 32 hex characters, unique, and show no counter-like clustering.
- [ ] `yarn test --maxWorkers=4` stays green (94 files / 1096 tests at baseline);
      `npx tsc --noEmit -p tsconfig.app.json` stays at 6 errors.

## Decisions

Resolved 2026-09-04.

1. **Uploads are refused when `DEMO_MODE` is set.** A public upload endpoint on
   a demo deployment is an open file drop. `403` from the handler before any R2
   write, and an explicit route test. `DEMO_MODE` already acks and drops queued
   mail, so a demo instance cannot send what it stores anyway.
2. **Dimensions are parsed from the file header, in the worker.** PNG, JPEG,
   GIF and WebP all carry width and height in their leading bytes; reading them
   is roughly 60 lines and no new dependency (`sharp` does not run on Workers).
   Correct `width`/`height` attributes measurably reduce layout shift in webmail,
   and the parser doubles as the magic-byte check the upload allowlist needs —
   one pass over the header serves both.
