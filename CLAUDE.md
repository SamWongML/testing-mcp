# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An LLM-driven API testing platform exposed over MCP. Tests are authored as typed, declarative
`defineTest`/`defineSuite` values, compiled to a normalized JSON manifest, and executed by a pure
in-house DAG engine. The result is rendered to Markdown / HTML / JUnit / an `llm_summary`.

## Session workflow — read before doing any phase work

The platform is built in sequential phases (P0–P11). `docs/PROGRESS.md` is the **index** — it is
kept under 150 lines, so read it whole. Every session:

1. Open `docs/PROGRESS.md`, find the first phase not marked `✅ done`, and read its checklist and
   *Entering P<n>, read* pointer. Read `docs/deferred.md` — it carries work earlier phases parked
   for this one.
2. Read that phase's section in `docs/implementation-plan.md`, then **only** the `docs/research.md`
   sections it references. `research.md` is ~30k tokens; never read it whole.
3. Verify the previous phase's exit-criteria commands still pass before building on it.
4. Build within the phase's file scope. Work belonging to a later phase → append it to
   `docs/deferred.md` under that phase; don't do it now.
5. Close out by following *Archiving a finished phase* in the index, then commit and push.

Handoff notes for `✅ done` phases live in `docs/phases/P<n>.md` — read one **only** if the current
phase revisits that work. **Never let `PROGRESS.md` grow past 150 lines**: it is read in full every
session and is the largest fixed context cost of a session start.

**Current state:** P0–P7 done; P8 (worker + MCP Tasks — async lifecycle) next. `@atp/schema`,
`@atp/engine`, `@atp/reporting`, `@atp/store`, `@atp/cli`, `@atp/mcp-server` (stateless sync surface
— `pnpm dev:server`), and `tools/compile` are implemented, with a sample corpus in `tests/`.
`@atp/store`'s integration tests gate on `ATP_TEST_DATABASE_URL` (see `docker-compose.dev.yml`) and
skip without it — the 27 skips in a local `pnpm test` are expected, not a regression.

## Commands

```bash
pnpm install                 # Node 22+ required; `corepack enable` (pnpm 10.33 is pinned)
pnpm typecheck               # tsc --noEmit over packages/*/src + tools/*/src — the authoritative check
pnpm lint                    # eslint
pnpm test:quiet              # vitest run --reporter=dot — the in-loop default
pnpm test                    # vitest run, full reporter — use when something fails
pnpm format                  # prettier --write .   (Markdown is intentionally excluded)
pnpm compile                 # discovery → dist/manifest.json
pnpm atp list|run|validate   # local dev CLI over the tests/ corpus (P4)
```

CI (`.github/workflows/ci.yml`) runs — and must stay green on — install → typecheck → lint → test.

Narrow the test run while iterating: `pnpm exec vitest run <path>` (one file), `pnpm exec vitest run
-t "<substring>"` (by name), `pnpm --filter @atp/engine test` (one package).

## Architecture

**The pipeline.** Authored TypeScript (`defineTest`/`defineSuite`, which carry real functions) →
normalizer → normalized JSON **manifest** (fully serializable) → the **engine** executes it → a typed
`ExecutionResult` → renderers. The manifest — not the source files — is what the server loads at
runtime (ADR-003).

**Monorepo layout.** pnpm workspaces over `packages/*` and `tools/*`. Internal `@atp/*` packages
resolve to their `src/index.ts` via the `exports` field, so cross-package imports need no build step
in dev/test. To add a cross-package dependency, add `"@atp/x": "workspace:*"` to that package's
`dependencies` and run `pnpm install`. Dependency direction: `schema` ← `engine` ← everything else;
`tools/compile` builds on `schema` + `engine`. The package-responsibility table is in `README.md`.

Per-package detail (representation model, execution model, template scopes, store test gating, MCP
statelessness) lives in `.claude/rules/*.md` and loads automatically when you open a file it covers.

## Invariants

These hold across all phases (ADR references point into `docs/research.md`):

- **Schema is the source of truth** — representation changes land in `@atp/schema` first (ADR-003).
- **The engine stays pure** — never import MCP or AWS code into `@atp/engine`.
- **Redact before persist** — any request/response snapshot passes `redact()` first.
- **Additive MCP tool surface** — never rename or remove a tool or field; add optional fields.
- **Stateless request path** — no cross-request memory in the MCP service (ADR-002).
- **Every run records `manifestHash` + `gitSha`.**

## Conventions

- TypeScript strict + ESM throughout. The base tsconfig sets `verbatimModuleSyntax`,
  `isolatedModules`, and `noUncheckedIndexedAccess`, so use `import type` for type-only imports and
  treat indexed access as possibly-`undefined`.
- Cheap structural guards live in the `defineX` helpers (fail fast where the value is authored);
  shape validation lives in Zod `.refine`s (fail at parse time). Ids are addressing keys (`needs`
  edges, `{{nodes.X.*}}` templates, manifest lookup) and are `.refine`d unique.
- **Test-file location matters.** Platform unit tests sit beside their source as
  `packages/**/src/**/*.test.ts` (and `tools/**/src/**/*.test.ts`) — exactly what `vitest.config.ts`
  matches. The `tests/` corpus is *also* `*.test.ts` but is deliberately **not** matched by that
  config; keep platform unit tests under `src/`.

## Key docs

- `docs/PROGRESS.md` — the index: phase status, the current phase's checklist, archiving procedure.
- `docs/implementation-plan.md` — the phase-by-phase plan with per-phase exit criteria.
- `docs/research.md` — architecture rationale and ADRs (large; read only the sections a phase cites).
- `docs/deferred.md` — work parked for a later phase. Read at the start of every phase.
- `docs/phases/P<n>.md` — archived handoff notes, one per done phase. On demand only.
- `README.md` — the package-responsibility map.

## Compact Instructions

When compacting, preserve verbatim: the current phase id and its unfinished checklist items from
`docs/PROGRESS.md`, that phase's exit criteria, the exact command and output of the most recent
failing check, and any file paths edited but not yet verified. Drop file contents already written to
disk and the reasoning that led to committed decisions — re-read the file instead.
