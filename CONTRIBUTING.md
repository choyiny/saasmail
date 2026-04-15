# Contributing to cmail

Thanks for your interest in contributing to cmail.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/cmail.git`
3. Install dependencies: `yarn install`
4. Follow the [Local Development](README.md#local-development) section in the README to set up your environment

## Making Changes

1. Create a branch from `main`: `git checkout -b my-feature`
2. Make your changes
3. Run tests: `yarn test`
4. Run type checking: `yarn tsc --noEmit`
5. Commit and push your branch
6. Open a pull request against `main`

## Pull Request Guidelines

- Describe what your PR does and why
- Keep PRs focused — one feature or fix per PR
- Include any relevant migration files if you changed the database schema (`yarn db:generate`)

## Code Style

- TypeScript strict mode
- Follow existing patterns in the codebase
- Tailwind CSS for styling (dark theme using the existing color tokens)
- Hono + Zod OpenAPI for backend routes
- Drizzle ORM for database queries

## Reporting Issues

Open an issue on GitHub with:

- What you expected to happen
- What actually happened
- Steps to reproduce
