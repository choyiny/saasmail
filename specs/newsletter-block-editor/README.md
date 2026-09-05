# Capability map: newsletter block editor

Give newsletter authors a visual, block-based editing surface that emits
email-safe HTML, without disturbing the transactional/sequence paths that
share `email_templates`.

Prior art analysed: [Keila](https://github.com/pentacent/keila) — Editor.js +
per-block Liquid partials + a Floki CSS inliner. What we take and what we
deliberately diverge on is recorded per module.

## Modules

| Module id          | Responsibility                                                                             | Depends on                         |
| ------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| `block-compiler`   | Pure TS. Block document (JSON) → email-safe HTML. Schema, emitters, theme tokens.          | —                                  |
| `image-assets`     | Public, cacheable, R2-backed image hosting for newsletter images. Upload + serve.          | —                                  |
| `template-formats` | Persistence and API: `format` discriminator, `bodyJson` column, compile-on-save wiring.    | `block-compiler`                   |
| `block-editor-ui`  | Tiptap editing surface in the template editor: block palette, live preview, format toggle. | `template-formats`, `image-assets` |

Build order: `block-compiler` + `image-assets` (parallel) → `template-formats` → `block-editor-ui`

Each module ships and is verifiable on its own. `block-compiler` is a pure
function with golden-file tests and no I/O. `image-assets` is an upload/serve
pair usable before any block exists. Neither imports the other.

## The one architectural invariant

**`email_templates.bodyHtml` remains the single rendering source.**

Block templates store `bodyJson` _and_ the compiled `bodyHtml`. The compiler
runs at save time, in the worker. Nothing downstream changes: the campaign
snapshot (`worker/src/lib/campaign-sender.ts:92-119`), sequence sends, the
template send API, `analyzeTemplate`, and `rewriteCampaignLinks` all keep
reading `bodyHtml` and never learn that blocks exist.

This is a deliberate divergence from Keila, which stores only `json_body` and
renders on the send path. Keila can afford that because `json_body` feeds
campaigns alone; our `bodyHtml` is load-bearing in four more places.

**Consequence to accept:** a theme change does not retro-apply to existing
templates without an explicit recompile. That matches the "content is frozen"
posture already documented in `docs/newsletters.md`.

## Variables are not the compiler's problem

`{{name}}` typed inside a block is literal text to the compiler. It flows into
the compiled `bodyHtml` and is interpolated per recipient downstream exactly as
today. The compiler MUST NOT parse, escape, or rewrite `{{…}}`.

Keila applies Liquid recursively over every string leaf of the block JSON
(`lib/keila/mailings/renderer/body_renderer/block.ex:96-121`). We do not need
that, and we do not want it: it puts a template engine in contact with every
URL and image `src` in the document.

## Shared conventions

These apply to every module spec below; they are not repeated in each.

**Commands**

```
Install:    yarn install --frozen-lockfile
Frontend TC: npx tsc --noEmit -p tsconfig.app.json   # NOT `yarn tsc --noEmit`
Unit tests: yarn test --maxWorkers=4   # vitest run --config vitest.config.test.ts
E2E:        yarn test:e2e              # wipes local D1; re-seed with yarn db:seed:dev
Format:     yarn format                # CI runs yarn format:check full-tree
Migrations: yarn db:generate           # never hand-author migrations/*.sql
```

> **`yarn tsc --noEmit` typechecks nothing. Measured, 2026-09-04.** The root
> `tsconfig.json` has `"files": []` and only a project _reference_; plain `tsc`
> does not build references without `--build`, so the command exits clean in
> ~1s having checked no file at all — frontend included. It is not a gate.
>
> - **Frontend:** `npx tsc --noEmit -p tsconfig.app.json`. Standing baseline of
>   **6 pre-existing errors** in `ChatInboxSection`, `PublicLayout`,
>   `PushOptInBanner`, `lib/push`, `OnboardingPage`, `SettingsPage`. Compare
>   counts against 6; do not expect zero.
> - **Worker:** there is no usable typecheck gate. `worker/tsconfig.json` is not
>   standalone — it includes `worker-configuration.d.ts` relative to `worker/`
>   while the file sits at the repo root, so running it directly yields **430
>   errors**, nearly all missing `CloudflareBindings` / `Env.R2`. Verify worker
>   code with `yarn test` instead: `@cloudflare/vitest-pool-workers` actually
>   compiles and runs it.

> **Worker strict mode is off.** `worker/tsconfig.json` sets no `strict`, so
> TypeScript discriminated unions **do not narrow** under `switch (block.type)`
> in worker code. This is why the block schema is defined in Zod rather than as
> a hand-written TS union — see `SPEC-block-compiler.md`.

**Project structure**

```
worker/src/lib/blocks/        → compiler: schema, emitters, theme  (new)
worker/src/routers/           → Hono + Zod OpenAPI routes
worker/src/db/*.schema.ts     → drizzle table definitions
worker/src/__tests__/         → worker unit tests (vitest)
src/components/blocks/        → Tiptap block nodes                 (new)
src/pages/TemplateEditorPage.tsx → editing surface
migrations/                   → drizzle-kit generated SQL
specs/newsletter-block-editor/   → these documents
docs/                         → user-facing product docs
```

**Code style** — match the surrounding file. Comments explain _why_, in the
declarative voice used across `worker/src/lib/` (see `campaign-sender.ts` for
the register). Example of the expected density:

```ts
// The compiler never touches `{{…}}`. Interpolation happens per recipient,
// after the snapshot — parsing it here would mean two engines disagreeing
// about what a brace means.
function emitParagraph(block: ParagraphBlock, theme: Theme): string {
  return `<tr class="block block--paragraph"><td style="${cell(theme)}">${block.data.html}</td></tr>`;
}
```

**Testing strategy** — vitest, tests in `worker/src/__tests__/*.test.ts`
alongside the existing suite. The compiler is tested by golden files (fixture
block document → expected HTML, byte-stable). Routes are tested at the handler
level like `email-templates-router.test.ts`. E2E covers the editor surface only.

**Boundaries**

- **Always:** run `yarn format`, both typecheck lines, and `yarn test` before
  pushing; add a `## [Unreleased]` entry to `CHANGELOG.md`; update the relevant
  `docs/` page when behaviour changes.
- **Ask first:** any change to `bodyHtml`'s role as the rendering source; any
  new dependency; anything that alters the campaign snapshot contract.
- **Never:** hand-author `migrations/*.sql` or edit `migrations/meta/`; make
  the compiler aware of `{{…}}`; store base64 data URIs in a block document.
