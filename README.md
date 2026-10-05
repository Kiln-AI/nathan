<img width="64" height="64" alt="12236640444448_5c07953571a6f3757f1c_512" src="https://github.com/user-attachments/assets/31660747-b543-42be-94ad-1e4183833072" />

# nathan

Our Slack bot: a small Cloudflare Worker (TypeScript) for deterministic team automation. Specs live in `specs/projects/nathan/`.

- `npm ci`, then `npm run check` (lint, type-check, config validation, tests).
- Team config: `nathan.config.ts`. Setup, deploys and the launch checklists: [docs/setup.md](docs/setup.md).
- `npm run verify:github -- <env>` checks an environment's GitHub App live (token, sweep cost, required checks).
- New features go in `src/features/<id>/` and are added to `src/features/index.ts`.
