# nathan

Our Slack bot: a small Cloudflare Worker (TypeScript) for deterministic team automation. Specs live in `specs/projects/nathan/`.

- `npm ci`, then `npm run check` (lint, type-check, config validation, tests).
- Team config: `nathan.config.ts`. Setup, deploys and the launch checklists: [docs/setup.md](docs/setup.md).
- `npm run verify:github -- <env>` checks an environment's GitHub App live (token, sweep cost, required checks).
- New features go in `src/features/<id>/` and are added to `src/features/index.ts`.
