# saasmail

Self-hosted email server on Cloudflare Workers. README.md is the overview; full documentation lives in **[docs/](./docs/README.md)** (setup, configuration, architecture, and one page per feature).

Contributor and coding-agent conventions (CI gates, Prettier, PR semver labels, drizzle migrations including data-only `--custom`): see **[AGENTS.md](./AGENTS.md)**.

## Development

- Use `yarn` for all dependency commands (not npm)
- Backend: Hono + Zod OpenAPI routes in `worker/src/routers/`
- Frontend: React + Tailwind in `src/`
- Database: Drizzle ORM with D1 in `worker/src/db/`
- Run `yarn typecheck` to type-check before committing
- Run `yarn test` for tests
- Run `yarn format` / `yarn format:check` before pushing (CI enforces Prettier)

## Skills

- `/saasmail-onboarding` — Interactive setup wizard for deploying a new saasmail instance
- `/use-saasmail` — How to call a deployed saasmail instance's HTTP API to send emails (raw or via templates) and enroll recipients in sequences
- `/create-saasmail-template` — Authoring email templates: the `{{variable}}` grammar, conditional and repeating `{{#section}}` rules, escaping, and the required-vs-optional send contract
- `/update-saasmail` — Rebase a fork onto `upstream/main` (links the upstream remote if needed)

## Session habits

- Before editing, read the whole file (or the whole function you're changing) and plan the change. If you've edited the same spot three times for one request, stop and re-read the request: repeated patches usually mean it was misread.
- When I correct you, re-read my message and say in one line what changes, then do it. Ask first only if the correction is ambiguous.
- When the same approach fails twice (a command, a fix that doesn't hold), change approach instead of retrying it. If a second approach also fails, stop and tell me what you tried, what failed and what you'd try next.
- Before you report back, re-read my original message and check off every part of it; finish what's missing or say which parts are left and why. In a long session, also re-read it before starting each new part.

## Specs and tasks

- Specs go in `docs/specs/` as `SPEC-<slug>.md`; plans, task lists, handoffs and run notes go in `docs/tasks/`; shipped or dropped work goes in `docs/archive/`. Create the folders when missing; nothing goes at the repo root.
- When work ships or is dropped, `git mv` its spec and tasks to `docs/archive/` under the same names, add a line to `docs/archive/README.md` (file, what shipped or why it was dropped, month) and fix any path that cites them (`git grep <file name>`).
- Never edit an archived spec to match today's code; new work gets a new spec.
- When `docs/specs/` or `docs/tasks/` holds something that looks finished or untouched for a month, list it and move it on my yes.

## Cloudflare

- Use the `cf` CLI. A folder with `cloudflare.config.ts` builds and deploys with cf (`cf build`, `cf deploy --mode <env>`), even while its old Wrangler config is still there; a folder with only a Wrangler config (`wrangler.toml`/`wrangler.jsonc`) keeps `wrangler` and its package scripts until it is migrated with `cf migrate`.
- Find commands with `cf cli search "<task>"` and `cf schema <command>`; run every write with `--dry-run` first; cf takes resource IDs, not names.
- Not in cf yet: live logs (`npx wrangler tail <worker>`) and single secrets (`npx wrangler secret put <NAME> --name <worker>`).
