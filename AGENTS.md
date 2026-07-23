# AGENTS.md — the contract for coding agents

Read this first. It is the durable contract for how to work in this repository:
conventions, the package map, and the recipes for adding and composing tests. Sections
marked _(filled in P4/P9)_ are placeholders that later phases complete — leave the
headings in place.

## How to run a session

This repo is built in phases. **Every session:**

1. Open [docs/PROGRESS.md](./docs/PROGRESS.md), find the first phase not marked `✅ done`,
   and read its handoff notes.
2. Read that phase's section in [docs/implementation-plan.md](./docs/implementation-plan.md),
   and only the `docs/research.md` sections it references.
3. Verify the previous phase's exit criteria still pass, then build the phase.
4. Update `docs/PROGRESS.md` (status, checkboxes, session log, handoff notes), commit,
   and push.

## Repository conventions

- **Monorepo:** pnpm workspaces. Packages live under `packages/*`; build tooling under
  `tools/*`; the test corpus under `tests/`.
- **Language:** TypeScript (strict), Node 22 LTS, ESM (`"type": "module"`) everywhere.
- **Package names:** `@atp/*`. Internal packages resolve to their `src/` via the
  `exports` field — no build step is needed for cross-package imports in dev/test.
- **Schema is the source of truth.** Any representation change happens in `@atp/schema`
  first; consumers adapt. Never fork the shape (ADR-003).
- **Engine stays pure.** No MCP or AWS imports in `@atp/engine`.
- **Redact before persist.** Any request/response snapshot passes `redact()` first.
- **Additive tool surface.** Never rename or remove an MCP tool; add optional fields.

## Package map

See [README.md](./README.md#package-map).

## Commands

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across the workspace
pnpm lint        # eslint
pnpm test        # vitest run
pnpm compile     # discovery → dist/manifest.json (P4+)
```

## Test corpus conventions _(filled in P4)_

- One executable test per `*.test.ts`; one composition per `*.suite.ts`.
- Folder = tag = ownership; shared building blocks live in `tests/_shared/`.

## Recipe: add a test _(filled in P4)_

## Recipe: compose a suite _(filled in P4)_

## Recipe: migrate from Insomnia _(filled in P9)_

## Recipe: triage a failure _(filled in P9)_

## MCP surface reference _(filled in P7–P9)_

Tools, prompts, and resources exposed by the server.
