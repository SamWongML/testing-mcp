# CLAUDE.md

## What this is

An LLM-driven API testing platform exposed over MCP. Tests are authored as typed, declarative
`defineTest`/`defineSuite` values, compiled to a normalized JSON manifest, and executed by a pure
in-house DAG engine. Results render to Markdown / HTML / JUnit / an `llm_summary`.

Authored TypeScript (which carries real functions) → normalizer → normalized JSON **manifest**
(fully serializable) → the **engine** executes it → a typed `ExecutionResult` → renderers. The
manifest, not the source files, is what the server loads at runtime.

## Commands worth knowing

```bash
pnpm test:quiet              # the in-loop default (dot reporter); pnpm test when something fails
pnpm compile                 # discovery → dist/manifest.json; run after touching tests/
pnpm validate                # compile + the strictness rules below — CI runs this
pnpm atp list|run|validate   # dev CLI over the tests/ corpus
pnpm atp import <file.yaml>  # scaffold defineTest/defineSuite drafts from Insomnia v5
pnpm atp golden <id> --base-url <url>   # run once against a real SUT → paste-ready parity asserts
pnpm synth                   # cdk synth, all four stacks — needs no AWS creds and no Docker
pnpm format                  # prettier; Markdown is deliberately excluded
```

Narrow the loop: `pnpm exec vitest run <path>` · `-t "<substring>"` · `pnpm --filter @atp/engine test`.

## Gotchas

- **A test that cannot fail is a build error.** `packages/cli/src/strict.ts` rejects a surviving
  `__TODO_CHAIN__` placeholder and a node asserting only a *range* on `status` — together, what
  let a half-finished Insomnia migration pass while testing nothing. An exact `status eq 204` with
  no body assert is deliberately legal.
- **Test-file location matters.** Platform unit tests sit beside their source under
  `packages/**/src/**/*.test.ts`. The `tests/` corpus is *also* `*.test.ts` but is deliberately not
  matched by `vitest.config.ts` — it is the product corpus, not unit tests.
- **Integration tests skip without their backing service** (`ATP_TEST_DATABASE_URL`,
  `ATP_TEST_DYNAMO_ENDPOINT`, `ATP_TEST_S3_ENDPOINT`; all three in `docker-compose.dev.yml`). Skips
  offline are expected. A green run with them skipped is *not* evidence the store paths work.
- **There is no build step.** `@atp/*` resolve to `src/index.ts` via the `exports` field, and the
  container runs the TypeScript under `tsx`. A new cross-package dep is `"@atp/x": "workspace:*"`
  plus `pnpm install`. Dependency direction: `schema` ← `engine` ← everything else.
- **Async runs need two processes** sharing one `DATABASE_URL`: `pnpm dev:server` and
  `pnpm dev:worker`. Without `DATABASE_URL` the server is sync-only and the worker fails fast.
- **AWS is off by default** — `TASK_STORE=postgres`, `ARTIFACT_STORE=local`, and
  `AUTH_ENABLED`/`OTEL_ENABLED`/`RUN_TASK_ENABLED` false — so dev and test need no cloud.

## Invariants

These hold from anywhere, including the packages with no rule file of their own (`reporting`,
`cli`, `tools/`):

- **Schema is the source of truth** — representation changes land in `@atp/schema` first.
- **The engine stays pure** — never import MCP or AWS code into `@atp/engine`.
- **Redact before persist** — every request/response snapshot passes `redact()` first.
- **Credentials are data + env** — providers are declarative `AuthProviderSpec`s carried by the
  manifest entry; their values are `{{secrets.*}}` templates filled from `ATP_SECRET_<KEY>`.
- **The MCP tool surface is additive** — never rename or remove a tool or field; add optional ones.

## Working here

The MCP surface is small and fixed: tests are *data*, so authoring a new test never needs a new
tool. The five agent workflows (authoring, suite composition, Insomnia migration, failure triage,
report regeneration) are executable templates in `packages/mcp-server/src/prompts/` — read the
template rather than reconstructing the workflow.

Delegate to a subagent only for large, genuinely independent tracks of work, such as a wide
multi-file investigation. Don't delegate what you can finish in a handful of tool calls, and don't
use subagents to verify your own work. Match written documents to what the task needs — cover the
substance without padding. Keep conversational replies brief and lead with the outcome; put the
supporting detail after it.

## Key docs

- `.claude/rules/*.md` — per-package detail.
- `docs/research.md` — architecture rationale and the ADRs. Large; it opens with a topic index.
- `docs/deploy.md` — the deployment runbook.
- `README.md` — the package-responsibility map.
