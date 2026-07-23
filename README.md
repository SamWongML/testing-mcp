# API Testing Platform

An LLM-driven API testing platform exposed over MCP. Tests are authored as typed,
declarative `defineTest`/`defineSuite` values, compiled to a normalized JSON manifest,
and executed by a pure in-house DAG engine.

- **Architecture:** [docs/research.md](./docs/research.md)
- **Implementation plan:** [docs/implementation-plan.md](./docs/implementation-plan.md)
- **Live status:** [docs/PROGRESS.md](./docs/PROGRESS.md)
- **Agent guide:** [CLAUDE.md](./CLAUDE.md)

## Package map

| Package | Name | Responsibility |
|---|---|---|
| `packages/schema` | `@atp/schema` | Zod schemas + inferred types — the single source of truth |
| `packages/engine` | `@atp/engine` | Pure execution engine (HTTP, assertions, DAG); no MCP/AWS deps |
| `packages/reporting` | `@atp/reporting` | `ExecutionResult` → Markdown / HTML / JUnit / `llm_summary` |
| `packages/store` | `@atp/store` | Persistence: Postgres record + queue, artifact store |
| `packages/mcp-server` | `@atp/mcp-server` | Stateless MCP server + async worker |
| `packages/cli` | `@atp/cli` | Local DX: `atp compile` / `list` / `run` / `validate` |
| `tools/compile` | `@atp/compile` | Discovery: `*.test.ts`/`*.suite.ts` → `dist/manifest.json` |
| `tests/` | — | The test corpus (grows to thousands) |

## Development

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across the workspace
pnpm lint        # eslint
pnpm test        # vitest run
pnpm compile     # build dist/manifest.json (P4+)
```

Requires Node 22+ and pnpm (`corepack enable`).
