# Contributing to saasmail

Thanks for your interest in contributing to saasmail. Please also read the [Code of Conduct](CODE_OF_CONDUCT.md) — it applies in every project space.

Coding-agent and CI conventions (Prettier, PR semver labels, drizzle `--custom` data migrations, local test prerequisites) live in **[AGENTS.md](AGENTS.md)** — same rules apply to human contributors.

## Licensing of contributions

saasmail is licensed under [Apache License 2.0](LICENSE). There is **no CLA**. By opening a pull request you agree that your contribution is licensed under the same Apache 2.0 license as the rest of the project, and that you have the right to license it.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/saasmail.git`
3. Install dependencies: `yarn install`
4. Follow the [Local Development](README.md#local-development) section in the README to set up your environment

## Making Changes

1. Create a branch from `main`: `git checkout -b my-feature`
2. Make your changes
3. Format: `yarn format` (CI runs `yarn format:check`)
4. Run tests: `yarn test`
5. Run type checking: `yarn tsc --noEmit`
6. If you changed the schema, generate a migration: `yarn db:generate` (data-only backfills: see [AGENTS.md](AGENTS.md) / [migrations/README.md](migrations/README.md))
7. Add an entry under `## [Unreleased]` in `CHANGELOG.md` for any user-visible change
8. Commit and push your branch
9. Open a pull request against `main` and label it `major`, `minor`, or `patch` (required by CI)

> Note: [AGENTS.md](AGENTS.md) holds contributor/CI notes used by coding agents (and humans). [CLAUDE.md](CLAUDE.md) is optional [Claude Code](https://claude.ai/claude-code) skill context — you don't need Claude Code to contribute.

## Pull Request Guidelines

- Describe what your PR does and why
- Keep PRs focused — one feature or fix per PR
- Include any relevant migration files if you changed the database schema (`yarn db:generate`)

## Code Style

- TypeScript strict mode
- Follow existing patterns in the codebase
- Tailwind CSS for styling (light theme using the existing color tokens)
- Hono + Zod OpenAPI for backend routes
- Drizzle ORM for database queries

## Reporting Issues

Open an issue on GitHub with:

- What you expected to happen
- What actually happened
- Steps to reproduce
