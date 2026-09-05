# Newsletter Block Editor — Tasks

Ordered by dependency. See [`plan.md`](./plan.md) for slices and risks,
[`specs/newsletter-block-editor/`](../../specs/newsletter-block-editor/README.md)
for the contract.

Slices **A–C are expanded** (near-term, detail is trustworthy). Slices **D–K are
stubs** — expanded when reached, so their detail is not written speculatively
against code that does not exist yet.

Every task also clears the Definition of Done in `plan.md`.

---

## Slice A — Compiler skeleton, one block end to end

**Goal:** a document containing a single paragraph compiles to a complete,
valid email document. Proves shell + theme + sanitizer + golden harness before
six more emitters are written against them.

- [x] **A.1 Zod block schema**
  - Acceptance: `BlockDocumentSchema` and `BlockSchema` per `SPEC-block-compiler.md`,
    all seven variants declared. `z.infer` types exported. `data: {}` on
    `separator`. `Url` refinement rejects `data:`.
  - Verify: unit test — a valid doc parses; a `data:` image `src` fails; an
    unknown `type` fails.
  - Files: `worker/src/lib/blocks/schema.ts`, `worker/src/__tests__/blocks-schema.test.ts`
  - Scope: S — Depends on: none

- [x] **A.2 Inline-HTML sanitizer as a Zod transform**
  - Acceptance: allowlist exactly `b/strong/i/em/u/s/a[href]/br/span[style:color]`;
    everything else stripped with text preserved; `javascript:`/`data:`/`vbscript:`
    hrefs dropped. Wired as `.transform()` on `InlineHtml` so there is no
    validate-without-sanitize path.
  - Verify: unit test — `<script>`, `onerror=`, `javascript:` href, `style` with
    `expression()` all neutralised; `{{name}}` passes through byte-identical.
  - Files: `worker/src/lib/blocks/sanitize.ts`, `worker/src/__tests__/blocks-sanitize.test.ts`
  - Scope: M — Depends on: A.1

- [x] **A.3 Theme tokens + document shell**
  - Acceptance: `Theme` record with the tokens named in the spec; `ThemeOverrides`
    validates colours as `#rrggbb`, lengths as `\d+(px|%)`, fonts against a stack
    allowlist. Shell emits doctype, `mso` conditional wrapper, 600px centred
    table, preheader span, and the single `<style>` carrying media queries only.
  - Verify: unit test — an override with `#fff` or `red` or `1em` is rejected
    (CSS-injection guard); shell output contains exactly one `<style>`.
  - Files: `worker/src/lib/blocks/theme.ts`, `worker/src/lib/blocks/shell.ts`,
    `worker/src/__tests__/blocks-theme.test.ts`
  - Scope: M — Depends on: A.1

- [x] **A.4 Paragraph emitter + `compile()` + golden harness**
  - Acceptance: `compile(doc)` is pure, synchronous, total for any schema-valid
    doc. Paragraph emitter returns exactly one `<tr class="block block--paragraph">`.
    Golden files committed under `worker/src/__tests__/fixtures/blocks/`.
  - Verify: `compile()` of the paragraph fixture is byte-identical to its golden
    file; re-running twice produces identical output (no ordering nondeterminism).
  - Files: `worker/src/lib/blocks/emitters.ts`, `worker/src/lib/blocks/compile.ts`,
    `worker/src/__tests__/blocks-compile.test.ts`, fixtures
  - Scope: M — Depends on: A.2, A.3

### Checkpoint A ✅

- [x] `yarn test --maxWorkers=4` green (97 files / 1163 tests, was 94 / 1096);
      `npx tsc --noEmit -p tsconfig.app.json` still at 6
- [x] The module also passes a `--strict` typecheck in isolation, which is
      stronger than anything the repo's own gates apply to worker code
- [x] Emitter contract set: one `<tr>` per block, class names carried but not
      load-bearing, font properties repeated per cell

**Deviation:** A and B were built in one pass rather than gated between them.
The engineering reason for the split — proving the shell, theme, sanitizer and
test harness on one block type first — was met: paragraph went green before the
other six emitters were written.

---

## Slice B — Remaining six emitters

- [x] **B.1 `heading`, `quote`, `separator`** — text-shaped, no new mechanics
  - Verify: golden file per type; heading levels restricted to 1–3
  - Files: `emitters.ts`, fixtures, `blocks-compile.test.ts` — Scope: S — Depends on: A.4

- [x] **B.2 `list`** — ordered/unordered, items are sanitized inline HTML
  - Verify: golden file for both; a 200-item list compiles; nested lists are not
    representable (flat by schema) and that is asserted
  - Files: `emitters.ts`, fixtures — Scope: S — Depends on: A.4

- [x] **B.3 `image`** — `src`, `alt`, optional `width`/`href`/`caption`, alignment
  - Verify: golden files for bare, linked, captioned and aligned variants;
    output carries `width`/`height` attrs and `max-width:100%` for mobile
  - Files: `emitters.ts`, fixtures — Scope: S — Depends on: A.4

- [x] **B.4 `button`** — square bulletproof table, no VML (decision 2, compiler spec)
  - Verify: golden files for centred and full-width; the anchor's `href` survives
    a `{{variable}}`; no `border-radius` reliance for correctness
  - Files: `emitters.ts`, fixtures — Scope: S — Depends on: A.4

- [x] **B.5 Kitchen-sink golden** — one document using all seven block types
  - Verify: byte-identical golden; block order is row order
  - Files: fixtures, `blocks-compile.test.ts` — Scope: XS — Depends on: B.1–B.4

### Checkpoint B — one item outstanding

- [x] All seven emitters golden-tested; `yarn test --maxWorkers=4` green
- [ ] **Kitchen-sink output rendered manually in Gmail and Outlook.** The one
      check CI cannot perform (see `plan.md` risks). Generate the HTML with
      `npx tsx scripts/regen-block-golden.mts` and send it to a real inbox.

**Two real bugs the golden caught**, both of which would have shipped to a
mailing list:

1. **Every font stack broke its own `style` attribute.** The families were
   written `"Segoe UI"` with double quotes and interpolated into `style="…"`,
   which closes the attribute. Fixed by quoting family names with single
   quotes; asserted by a test that no `style` attribute value contains a raw
   double quote.
2. **`{{unsubscribe_url}}` was rejected as an href.** `UrlSchema` demanded an
   `http(s)`/`mailto` scheme, and the sanitizer silently stripped the attribute
   in prose — the worse of the two failures, since it produces a campaign that
   looks fine and carries a dead unsubscribe link. Both now accept a target
   that begins with a template tag, and still refuse `javascript:{{x}}`.

---

## Slice C — Compiler hardening

- [x] **C.1 Adversarial sanitizer suite**
  - Verify: nested/malformed tags, mutation-XSS vectors, `<svg onload>`,
    entity-encoded `javascript:`, unbalanced quotes in attributes
  - Files: `blocks-sanitize.test.ts` — Scope: S — Depends on: A.2

- [x] **C.2 `{{variable}}` survival + `analyzeTemplate` integration**
  - Acceptance: the compiler never parses, escapes or rewrites `{{…}}`
  - Verify: `analyzeTemplate(subject, compile(doc))` reports a variable placed in
    a paragraph, a button label and a button `href` as required; every fixture
    produces no parse error
  - Files: `worker/src/__tests__/blocks-variables.test.ts` — Scope: S — Depends on: B.5

- [x] **C.3 Schema limits** — 500 blocks, 10k inline chars, 200 list items
  - Verify: at-limit passes, over-limit rejects with a message naming the limit
  - Files: `blocks-schema.test.ts` — Scope: XS — Depends on: A.1

### Checkpoint C — `block-compiler` complete ✅

- [x] Module is pure and synchronous; its only import outside
      `worker/src/lib/blocks/` is `zod`, so it is importable from `src/` for the
      preview in Slice J
- [x] `yarn test --maxWorkers=4` green; frontend typecheck still at 6

**Deviation — golden files.** The spec asked for fixture files compiled
byte-identically. Vitest snapshots write through the filesystem, which is not
reliable under `vitest-pool-workers`, so the golden is a committed TypeScript
module (`fixtures/kitchen-sink.expected.ts`) imported by the test and
regenerated with `npx tsx scripts/regen-block-golden.mts`. Same guarantee, no
filesystem dependency.

**Not built, deliberately:** `sanitize-signature.ts` was not reused. It is an
async `HTMLRewriter` denylist; the compiler is sync by contract and needs a
much narrower allowlist. The rationale is recorded at the top of
`worker/src/lib/blocks/sanitize.ts`.

---

## Slice D — Image assets: table + upload ✅

- [x] **D.1** `newsletter_assets` schema + `migrations/0039_amazing_mastermind.sql`
      (generated, additive, one new table + one index). Registered in
      `db/index.ts`, `db/schema.ts`, **and** the hand-maintained DDL in
      `__tests__/helpers.ts` — that last one is not the drizzle migration and is
      easy to miss; without it every route test fails on a missing table.
- [x] **D.2** `readImageHeader` — PNG / JPEG / GIF / WebP, magic-byte allowlist
      and dimension read in one pass. 15 tests, most asserting a refusal.
- [x] **D.3** `POST /api/newsletter-assets` — 5 MB cap, SHA-256 dedupe,
      `DEMO_MODE` refusal, 128-bit hex ids from `crypto.getRandomValues`.

**Deviation:** raw body bytes rather than `multipart/form-data`, matching the
CSV import at `lists-router.ts:934`. Multipart would add a parser whose declared
headers we ignore anyway in favour of magic bytes.

## Slice E — Image assets: public serve route ✅

- [x] **E.1** `GET /newsletter-images/{id}`, mounted outside `/api` so it never
      meets the session/passkey/inbox middleware.
- [x] **E.2** Five hardening headers asserted by test; empty `404` for an
      unknown id, with no distinction between "never existed" and "deleted".

**Deviation — the mount point moved.** The spec said `/assets/n/{id}`. Vite
emits the SPA bundle to `dist/client/assets/`, so a router at `/assets` would
sit on top of the application's own JavaScript and the winner would be decided
by static-asset ordering. Caught before it shipped. The prefix is now the
`PUBLIC_ASSET_PATH` constant.

### Checkpoint D–E ✅

- [x] An image uploads and is fetchable with no session cookie and no API key —
      asserted directly, which is also the proof the route really is outside the
      auth middleware
- [x] `yarn test --maxWorkers=4`: 99 files / 1191 tests, 0 failed
      (was 97 / 1163 after `block-compiler`)
- [x] `npx tsc --noEmit -p tsconfig.app.json` still at 6

## Slice F — template-formats: migration + write path ✅

- [x] **F.1** `format` (`NOT NULL DEFAULT 'html'`) and `body_json` columns on
      `email_templates`; `migrations/0040_cool_captain_cross.sql`, generated,
      two `ALTER TABLE ADD COLUMN` statements and nothing else. The default is
      what makes it additive — no backfill pass exists or is needed.
- [x] **F.2** `lib/template-body.ts` — one resolver shared by `POST` and `PUT`.
      Written as a single helper because the format rules are exactly the kind
      of thing that diverges when written twice, and the symptom would be a
      template whose `bodyHtml` no longer matches its `bodyJson`.
- [x] **F.3** Compile-on-save, with `templateParseError` running on the
      _compiled_ output so a malformed `{{#section}}` typed into a block fails
      the write with the same diagnostic a hand-written template produces.
- [x] **F.4** `400` when `bodyHtml` accompanies `format: "block"`.

## Slice G — Read path, conversion, OpenAPI ✅

- [x] **G.1** `GET` returns `format` and `bodyJson`; both added to
      `EmailTemplateSchema`.
- [x] **G.2** `block` → `html` conversion keeps the compiled HTML and nulls
      `bodyJson`; `html` → `block` refused with `422`.
- [x] **G.3** `/doc` regenerates cleanly — `openapi-doc.test.ts` passes
      unchanged.

`bodyJson` is typed as a loose record in the OpenAPI schema on purpose:
`BlockDocumentSchema` carries `.transform()` sanitization, so feeding it to the
doc generator would publish the _input_ shape while the route stores the
transformed one. Strict validation happens in the handler instead.

**A bug the tests caught:** a `data:` image URL reported the generic "URL must
be http(s)" message, because the scheme refinement was declared before the
`data:` one. A pasted data URI is the single most likely mistake here — it is
what the inbox editor produces — so the checks were reordered to give the
actionable message.

## Slice H — Campaign integration proof ✅

- [x] **H.1** A campaign whose template is `format: "block"` snapshots,
      derives its text part, and freezes correctly.
- [x] **H.2** `{{subscriber_name}}` and `{{unsubscribe_url}}` survive into the
      snapshot for per-recipient interpolation.
- [x] **H.3** A later edit to the block template does not change a snapshot
      already taken.

**The invariant held.** `campaign-sender.ts`, `interpolate.ts` and
`send-template.ts` are untouched by this entire module — verified against
`git status`, not assumed. Block templates are invisible to the send path.

### Checkpoint F–H ✅

- [x] Block templates send through the unmodified campaign path
- [x] Every pre-existing template still reads back byte-identical, including a
      row inserted without the new columns (the DB default supplies `format`)
- [x] `yarn test --maxWorkers=4`: 100 files / 1208 tests, 0 failed
      (was 99 / 1191 after `image-assets`)
- [x] `npx tsc --noEmit -p tsconfig.app.json` still at 6

## Slice I — Editor UI: Tiptap nodes + serializer ✅

- [x] **I.1** `serialize.ts` — Tiptap JSON ⇄ block document, operating on plain
      objects rather than an `Editor`, so it is testable without a DOM.
      21 tests under `vitest.config.web.ts`.
- [x] **I.2** `nodes.tsx` — `emailButton` and `emailImage` as atom nodes with
      React node views. StarterKit's own `image` is **not** enabled: it would
      let an author paste a `data:` URI straight into the document, which is the
      exact failure the asset pipeline exists to prevent.
- [x] **I.3** Marks restricted to bold / italic / underline / strike / link, and
      serialized in a fixed order so the same document always produces the same
      bytes.

**Scope note — no new dependencies.** A colour mark and per-block text
alignment would each need an extension this repo does not have
(`@tiptap/extension-color`, `@tiptap/extension-text-align`). The compiler
supports both; the v1 editor exposes neither for text. Image and button
alignment is available, carried on their own node attributes.

## Slice J — Editor UI: page integration ✅

- [x] **J.1** `BlockEditor.tsx` with a toolbar; `TemplateEditorPage` swaps the
      CodeMirror pane for it when `format === "block"`.
- [x] **J.2** Preview compiled in the browser by the same module the worker runs
      on save. Falls back to the last valid compile while a document is
      mid-edit rather than blanking.
- [x] **J.3** Image insert, paste and drop all upload through
      `POST /api/newsletter-assets`; the error surfaces inline on the block
      rather than as a toast that disappears.
- [x] **J.4** "New block template" on `/templates` — a second entry point rather
      than an in-editor switch, because `html` → `block` is refused by the API.

**Two things this surfaced.**

1. **The compiler is now under a real CI gate.** Importing it from `src/` pulls
   it into `tsconfig.app.json`'s program — the first typecheck that has ever
   covered worker code in this repo. It immediately caught `replaceAll` (ES2021)
   against the app's ES2020 `lib`, in `shell.ts` and `sanitize.ts`. Rewritten as
   `replace(/x/g, …)` rather than widening the project's lib target.
2. **The client bundle gained no new runtime dependency.** `FONT_STACKS` was
   moved from `schema.ts` to `theme.ts` so `compile()`'s runtime import graph is
   `compile → emitters → shell → theme` and never reaches zod. Verified by
   walking the import graph, not by inspection.

## Slice K — E2E, docs, changelog ✅

- [x] **K.1** `e2e/specs/block-templates.spec.ts` — author a block template,
      assert the compiled preview, reopen it, and assert the demo-mode upload
      refusal. **3 passed.**
- [x] **K.2** `docs/templates.md` gains a "Block templates" section; the
      asset-accumulation note is in `docs/newsletters.md`.
- [x] **K.3** `CHANGELOG.md` `## [Unreleased]` under **Added**.
- [ ] **K.4** PR semver label — `minor`; applied by a maintainer when the PR is
      opened (AGENTS.md), nothing to do in the branch.

**Image upload is not exercised end to end, deliberately.** The e2e environment
runs `DEMO_MODE=1`, and uploads are refused in demo mode by design. The spec
asserts the refusal instead. A consequence worth knowing: a demo deployment
cannot demonstrate images in a newsletter.

### Checkpoint Complete — one item outstanding

- [x] All acceptance criteria met across A–K
- [x] `yarn test --maxWorkers=4`: 100 files / 1208 tests, 0 failed
- [x] `yarn test:web`: 10 files / 58 tests, 0 failed
- [x] `npx tsc --noEmit -p tsconfig.app.json` at 6 (the standing baseline)
- [x] `yarn build` clean; `yarn format:check` clean
- [x] `yarn test:e2e`: **50 passed, 1 failed** — the failure is
      `compose.spec.ts` › "Send button is disabled when body is empty", which
      fails on `main` too and is unrelated to this work (no compose, reply or
      `TiptapEditor` file is touched by it)
- [x] Both migrations applied cleanly onto a database that already held the
      previous 38 — the additive-migration criterion, verified rather than assumed
- [ ] **Render the kitchen sink in real Gmail and Outlook.** Still the one check
      CI structurally cannot perform. `npx tsx scripts/regen-block-golden.mts`,
      then send the HTML to a real inbox.
