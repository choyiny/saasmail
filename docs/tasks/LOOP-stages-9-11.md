# Loop prompt: implement stages 9–11 one spec at a time

Paste the block below as the prompt of a repeating run (Claude Code `/loop`, a `while` loop around
`claude -p`, or a scheduled task) started at the repo root. Each run works through the steps and ends with
the "What I need from you" list from `CLAUDE.md`. Since 2026-10-03 it merges a pull request itself once
every gate is green and carries on with the next spec (before that, merging stayed with you; #67 was
merged on your word).

```text
You are in the saasmail fork (repo root). Read CLAUDE.md and AGENTS.md first; they override this prompt.

Goal: implement stages 9–11, one spec per PR, in the order of docs/tasks/TASKS-stages-9-11.md
(§ Order), tracking state in its § Progress table. Never push to main, never force-push, never edit
anything under docs/archive/ (moving a shipped spec in and adding its README line excepted), never
loosen pinned dependencies. Merge a PR only as step 1 says: every local gate and every CI check
green, nothing left to address.

Work through the steps below and keep going from one spec to the next. Stop only when something
needs the user (a red gate you cannot fix, a decision that is theirs) or when step 4 is reached.

0. Sync and orient.
   git fetch origin && git checkout main && git pull --ff-only
   Read the Progress table. The "current spec" is the first row that is not `archived`.

1. If the current spec is `PR #N open`:
   - gh pr view N --json state,mergedAt,mergeCommit,statusCheckRollup,reviews,comments
   - Merged → set it to `merged <squash sha>` and go to step 2 in this same run.
   - Checks failing → checkout its branch, reproduce locally (yarn format:check, yarn typecheck,
     yarn test, yarn test:e2e if the failure is e2e), fix, commit, push. Stop.
   - Unresolved review comments → address each on the branch, reply on the PR, push. Stop.
   - Green with nothing to address → mark it ready (gh pr ready N) and squash-merge it with the PR
     title as the subject (gh pr merge N --squash --subject "<PR title> (#N)"), then treat it as
     Merged. If the merge is refused, stop with "What I need from you: 1. Merge PR #N."

2. If the current spec is `merged <sha>` (housekeeping, done as the first commit of the next
   spec's branch, or as its own small docs PR when it is the last spec):
   - git mv docs/specs/<spec> docs/archive/<spec>; add a line to docs/archive/README.md
     (file, what shipped with the PR number, month); git grep the file name and fix every citation.
   - roadmap.md: fill the row's PR number and squash commit.
   - Progress table: set the row to `archived`. Then continue with step 3 in the same run.

3. If the current spec is `todo` or `branch spec/<slug>`:
   - git checkout -B spec/<slug> (reuse the branch if it exists: read its log and diff first,
     and continue from where it stopped).
   - Read the whole spec. Read every file it names before changing it. Write a short plan as a
     checklist at the top of your reply, mapping each spec section to commits.
   - Implement in small commits in this order: schema + migration (yarn db:generate, or
     yarn auth:generate first for better-auth tables; update applyMigrations() in
     worker/src/__tests__/helpers.ts in the same commit), services, routes/tools/JMAP, UI, tests,
     docs page(s) named by the spec, CHANGELOG.md under ## [Unreleased] in the house style
     (**Bold title.** paragraph). New dependencies: exact pin, then yarn install --update-checksums.
   - Gates before each push: yarn format && yarn typecheck && yarn test. Run yarn test:e2e when
     the spec touches UI or HTTP routes (it wipes local D1; re-seed with yarn db:seed:dev after).
   - If the code contradicts the spec, or a decision in the spec turns out wrong: do not work
     around it. Edit the spec in this branch, add a "Spec changes" section to the PR body saying
     what changed and why, and name it in the end-of-run list.
   - When the spec is fully implemented and green: push, open a DRAFT PR titled after the spec's
     first heading, body = Why (two lines) + a checklist of the spec's numbered sections + Tests
     run + Docs updated + Migrations + Spec changes (or "none"); add the label the spec names
     (gh pr edit --add-label minor). Set Progress to `PR #N open`, wait for CI, and go to step 1.
   - If the spec is too large for one run: commit what is green, push the branch, set Progress to
     `branch spec/<slug>`, and stop with a note of what is left. Never leave the tree red.

4. If every row is `archived`: make sure roadmap.md and docs/README.md are consistent, then stop
   with "All twelve specs shipped. Nothing needed."

Rules of the house that bite here: D1 takes at most 100 bound parameters per statement (bind
lists as JSON through json_each or chunk at 40); scheduled() runs every job on every cron tick, so
never add a cron schedule; new queue work goes on EMAIL_QUEUE with a new type; limits live at the
HTTP/MCP/JMAP boundary; message reads go through queryMessages(); state mutations go through
worker/src/lib/messages/state.ts; every hard delete calls deleteMessageState() first; the worker
type check is a per-file ratchet (yarn typecheck:update-baseline only when you removed errors).

End every run with "What I need from you" (numbered, most blocking first, one action each) or
"Nothing needed."
```
