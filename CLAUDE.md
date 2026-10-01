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
