## Summary

<!-- One or two sentences on what this PR changes and why. Link any related issue. -->

## Changes

<!-- Bulleted list of user-visible or reviewer-visible changes. -->

-

## Release impact

<!--
Tick exactly one version bump. This applies the label that "Check PR labels"
requires — without it the check stays red. Tick the change type too, so the
release notes file this PR under the right heading.
-->

- [ ] Patch — bug fix or internal change, no new behaviour
- [ ] Minor — new backwards-compatible behaviour
- [ ] Major — breaking change

<!-- Change type (optional, categorises the release notes): -->

- [ ] Feature
- [ ] Bug Fix
- [ ] Refactor
- [ ] Documentation
- [ ] Chore

## Test plan

<!-- How did you verify this works? Include commands run and/or scenarios exercised. -->

- [ ] `yarn tsc --noEmit`
- [ ] `yarn test`
- [ ] `yarn test:e2e` (if the change touches UI or API surface)
- [ ] Manual verification:

## Notes for reviewers

<!-- Anything non-obvious: migrations, config changes, follow-ups, known gaps. -->

## Checklist

- [ ] Added or updated a migration (`yarn db:generate`) if the schema changed
- [ ] Updated `CHANGELOG.md` under `## [Unreleased]` for user-visible changes
- [ ] Updated docs (`README.md`, `docs/`) if behavior or setup changed
