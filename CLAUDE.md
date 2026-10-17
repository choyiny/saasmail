# saasmail

Self-hosted email server on Cloudflare Workers. README.md is the overview; full documentation lives in **[docs/](./docs/README.md)** (setup, configuration, architecture, and one page per feature).

Contributor and coding-agent conventions (CI gates, Prettier, PR semver labels, drizzle migrations including data-only `--custom`): see **[AGENTS.md](./AGENTS.md)**.

## Development

- Use `yarn` for all dependency commands (not npm)
- Backend: Hono + Zod OpenAPI routes in `worker/src/routers/`
- Frontend: React + Tailwind in `src/`
- Database: Drizzle ORM with D1 in `worker/src/db/`
- Run `yarn tsc -b` to type-check before committing (`yarn tsc --noEmit` checks no files — the root `tsconfig.json` only holds project references)
- Run `yarn test` for tests
- Run `yarn format` / `yarn format:check` before pushing (CI enforces Prettier)

## Installer

- `yarn saasmail install` (`scripts/saasmail/`, docs/setup.md) provisions, configures and deploys an instance deterministically; `yarn saasmail status` checks it. Pure modules plus a Cloudflare REST port and a process runner, tested with fakes by `yarn test` (Node vitest config in `scripts/saasmail/`); `yarn typecheck:cli` type-checks it. State lives in the gitignored `.saasmail/`.

## Skills

- `/saasmail-onboarding` — Guides `yarn saasmail install` (plan, then the user applies it in their own terminal) to deploy a new saasmail instance
- `/use-saasmail` — How to call a deployed saasmail instance's HTTP API to send emails (raw or via templates) and enroll recipients in sequences
- `/create-saasmail-template` — Authoring email templates: the `{{variable}}` grammar, conditional and repeating `{{#section}}` rules, escaping, and the required-vs-optional send contract
- `/update-saasmail` — Rebase a fork onto `upstream/main` (links the upstream remote if needed)
