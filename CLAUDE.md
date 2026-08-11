# saasmail

Self-hosted email server on Cloudflare Workers. See README.md for full documentation.

Contributor and coding-agent conventions (format check, tests, drizzle migrations including data-only `--custom`): see **[AGENTS.md](./AGENTS.md)**.

## Development

- Use `yarn` for all dependency commands (not npm)
- Backend: Hono + Zod OpenAPI routes in `worker/src/routers/`
- Frontend: React + Tailwind in `src/`
- Database: Drizzle ORM with D1 in `worker/src/db/`
- Run `yarn tsc --noEmit` to type-check before committing
- Run `yarn test` for tests
- Run `yarn format` / `yarn format:check` before pushing (CI enforces Prettier)

## Skills

- `/saasmail-onboarding` — Interactive setup wizard for deploying a new saasmail instance
- `/use-saasmail` — How to call a deployed saasmail instance's HTTP API to send emails (raw or via templates) and enroll recipients in sequences
- `/create-saasmail-template` — Authoring email templates: the `{{variable}}` grammar, conditional and repeating `{{#section}}` rules, escaping, and the required-vs-optional send contract
