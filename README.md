# nathan

Our Slack bot: a small Cloudflare Worker (TypeScript) for deterministic team automation. Specs live in `specs/projects/nathan/`.

- `npm ci`, then `npm run check` (lint, type-check, config validation, tests).
- Team config: `nathan.config.ts`. Setup and deploys: [docs/setup.md](docs/setup.md).
- New features go in `src/features/<id>/` and are added to `src/features/index.ts`.
