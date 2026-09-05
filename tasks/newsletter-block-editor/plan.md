# Implementation Plan: Newsletter Block Editor

Derived from [`specs/newsletter-block-editor/`](../../specs/newsletter-block-editor/README.md)
(four module specs, decisions resolved 2026-09-04). This plan does not restate the
specs — it decides **order, risk, and verification points**.

> Kept in its own directory rather than at `tasks/plan.md`, which still holds the
> newsletter-module plan from PR #1. That plan is complete apart from one no-op
> item (`I.4`, a maintainer-applied PR label) and is left untouched.

## Scope check

The capability map in the spec README already fixes module boundaries and build
order, so it serves as the capability map for this plan. Four modules become
eleven vertically sliced tasks; module ids are not renumbered or re-scoped.

## Dependency graph

```
  block-compiler                    image-assets
  schema + sanitize (A)             table + upload (D)
        │                                 │
        ▼                                 ▼
  emitters (B)                      public serve (E)
        │                                 │
        ▼                                 │
  hardening (C)                           │
        │                                 │
        └──────────┬──────────────────────┘
                   ▼
        template-formats: migration + write (F)
                   │
                   ▼
        read path + conversion + /doc (G)
                   │
                   ▼
        campaign integration proof (H)   ← the invariant is proved here
                   │
                   ▼
        editor UI: nodes + serializer (I)
                   │
                   ▼
        editor UI: page integration (J)
                   │
                   ▼
        E2E + docs + changelog (K)
```

`block-compiler` (A–C) and `image-assets` (D–E) are independent and can be built
in parallel. Everything from F onward is sequential.

## Architecture decisions

Carried from the specs; repeated here only where they shape the _order_ of work.

- **`bodyHtml` stays the single rendering source.** Block templates store
  `bodyJson` and the compiled `bodyHtml`. This is what keeps F and G small, and
  it is why **Slice H exists as its own task**: the claim "nothing downstream
  changes" is worth an explicit test rather than an assertion in a spec.
- **Zod, not a TS union, for the block schema.** Worker strict mode is off, so
  `switch (block.type)` would not narrow. Zod narrows via `z.infer` and gives the
  API-boundary validation the write path needs anyway.
- **No CSS inliner.** A fixed theme-token set is interpolated at emit time.
  Removes `HTMLRewriter` and its selector-subset limits from the design entirely.
- **Slice A is one block type end to end**, not "all the schema". The thin
  vertical slice proves the shell, theme, sanitizer and golden-test harness
  before six more emitters are written against them.

## Verification baseline

Measured 2026-09-04 on this machine, before any change:

| Gate                                    | Baseline                                   |
| --------------------------------------- | ------------------------------------------ |
| `yarn test --maxWorkers=4`              | 94 files, 1096 passed, 1 skipped, 0 failed |
| `npx tsc --noEmit -p tsconfig.app.json` | **6** pre-existing errors                  |
| `yarn format:check`                     | clean                                      |

Two traps, both verified rather than assumed:

- **`yarn tsc --noEmit` checks nothing.** Root `tsconfig.json` has `"files": []`
  and only a project reference; plain `tsc` does not build references. It exits
  clean in ~1s having read no source file. Use the `-p tsconfig.app.json` form.
- **There is no worker typecheck gate.** `worker/tsconfig.json` run directly
  yields 430 errors because it includes `worker-configuration.d.ts` relative to
  `worker/` while the file is at the repo root. Worker code is verified by
  `yarn test`, which compiles and runs it under `@cloudflare/vitest-pool-workers`.
- **Bare `yarn test` flakes on this machine.** 18 cores with no worker cap starts
  a `workerd` per test file and they starve each other. Always `--maxWorkers=4`.

## Risks and mitigations

| Risk                                                                  | Impact | Mitigation                                                                                                           |
| --------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| Outlook/Gmail rendering cannot be verified from a unit test           | High   | Golden tests pin _structure_; add one manual client-check gate before J closes. Accept that CI cannot prove it.      |
| The inline-HTML sanitizer is a security boundary with no second layer | High   | Sanitizer is a Zod `.transform()`, so no validate-without-sanitize path exists. Adversarial tests in Slice C.        |
| Public asset route is a stored-XSS surface on the app origin          | High   | Magic-byte allowlist (SVG excluded), stored `Content-Type` + `nosniff`, `CSP: default-src 'none'`. Route tests in E. |
| "Nothing downstream changes" turns out to be false                    | Medium | Slice H proves it against the real campaign snapshot path before any UI is built.                                    |
| Compiler drift between worker and browser preview                     | Medium | One module, imported by both. Slice J asserts preview output is byte-identical to stored `bodyHtml`.                 |
| Scope creep into columns / social icons / markdown / MJML             | Medium | Named as out of scope in `SPEC-block-editor-ui.md`. Columns alone are 55% of Keila's emitter code.                   |
| D1 migration applied to a seeded database                             | Low    | Additive columns with a default; verified against a pre-change seed in F.                                            |

## Task list

Tasks live in [`todo.md`](./todo.md). Slices **A–C are expanded**; **D–K are
stubs**, expanded when reached so their detail is not written speculatively
against code that does not exist yet — the same convention as the newsletter
module plan.

## Definition of done (every slice)

- `yarn test --maxWorkers=4` green, no new skips
- `npx tsc --noEmit -p tsconfig.app.json` still at 6 errors
- `yarn format` run
- The slice's own acceptance criteria met
- `CHANGELOG.md` `## [Unreleased]` updated once, in Slice K
