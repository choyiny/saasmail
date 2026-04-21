---
name: update-saasmail
description: Sync the local saasmail repo with the latest upstream changes from https://github.com/choyiny/saasmail. Use this skill whenever the user wants to update saasmail, pull upstream changes, sync with upstream, rebase on upstream, get the latest saasmail, or says "/update-saasmail". Handles adding the upstream remote if missing, rebases local commits on top of upstream/main, auto-stashes uncommitted work, and resolves conflicts by preferring upstream.
---

# Update saasmail from upstream

Sync the local saasmail fork with the latest changes from `choyiny/saasmail` while preserving the user's local commits on top.

## Why this exists

The user maintains a fork (or local clone) of `https://github.com/choyiny/saasmail` with their own commits layered on top. They want a one-shot command that:

1. Grabs the latest upstream state.
2. Replays their local commits on top (so local work stays at HEAD).
3. Doesn't get stuck on conflicts they don't care about — when a hunk can't auto-merge, upstream wins.

Regular `git pull` creates merge commits and doesn't give conflict preference. Regular `git rebase` halts on conflicts. This skill wraps the right invocation.

## Preconditions

Before running anything, confirm:

- Working directory is the saasmail repo (check for `wrangler.jsonc` or `wrangler.jsonc.example` and `worker/` directory). If not, stop and tell the user.
- The current branch is the one they want to update. Usually `main`. If they're on a feature branch, ask which branch to rebase onto upstream/main before proceeding.

## Steps

### 1. Ensure the `upstream` remote exists

Run `git remote -v` and check for an `upstream` entry pointing at `https://github.com/choyiny/saasmail` (allow `.git` suffix and `git@github.com:choyiny/saasmail.git` SSH form).

- If missing: `git remote add upstream https://github.com/choyiny/saasmail.git`
- If present but pointing elsewhere: stop and ask the user — don't silently rewrite a remote they configured deliberately.

### 2. Stash uncommitted changes if any

Run `git status --porcelain`. If there is any output (tracked modifications or staged changes):

```bash
git stash push -u -m "update-saasmail auto-stash"
```

Remember that you stashed, so you can restore at the end. Untracked-but-ignored files are fine to leave alone (`-u` covers untracked, not ignored).

### 3. Fetch upstream

```bash
git fetch upstream
```

### 4. Rebase onto upstream/main with upstream-wins conflict strategy

```bash
git rebase upstream/main -X ours
```

**About the `-X ours` flag:** Inside a rebase, "ours" is the branch being rebased _onto_ (upstream/main) and "theirs" is the commits being replayed (the user's local commits). So `-X ours` means: when a hunk can't be auto-merged, take upstream's version. Local commits are still replayed — their non-conflicting changes stay. This matches the user's intent: keep local work, but if a conflict is unresolvable, let upstream win.

If the rebase still stops (e.g., a whole file conflict that `-X ours` can't resolve, like add/add or delete/modify), report the conflicted paths to the user and ask whether to:

- abort (`git rebase --abort`) and let them resolve manually, or
- accept upstream's version wholesale for those paths (`git checkout --theirs -- <path>` is wrong here because we're in a rebase — use `git checkout --ours -- <path>` to take the upstream version, then `git add` and `git rebase --continue`).

Never run `git rebase --skip` without asking — that silently drops one of the user's commits.

### 5. Restore stashed changes

If you stashed in step 2:

```bash
git stash pop
```

If `stash pop` itself conflicts, leave the stash entry in place and tell the user — don't drop their uncommitted work.

### 6. Report what happened

Give the user a concise summary:

- Whether `upstream` was newly added or already configured.
- How many commits were pulled from upstream (`git rev-list --count HEAD@{1}..HEAD` after the rebase, or count from the fetch output).
- Whether any conflicts were auto-resolved in favor of upstream (check rebase output for `CONFLICT` lines that were resolved by the strategy).
- Whether stashed changes were restored cleanly.

## Non-goals

- Do NOT push to `origin` afterward. The user pushes when they're ready.
- Do NOT touch branches other than the current one.
- Do NOT rewrite the `upstream` remote if it already points somewhere unexpected — ask first.
