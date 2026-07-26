---
name: atp-workflows
description: The five agent workflows this platform exposes — authoring a test, composing a suite, migrating an Insomnia collection, triaging a failed run, regenerating reports. Use when adding or editing anything under tests/, wiring an imported collection, or investigating a run that failed.
---

# Working the ATP corpus

Each workflow below is already written as an executable MCP prompt in
`packages/mcp-server/src/prompts/index.ts`. **Read the template there rather than reconstructing
the steps** — it is the spec, it stays in sync with the tools, and editing it changes the workflow
for every caller at once.

Tests are *data*. Authoring one never needs a new MCP tool, only a new file under `tests/`.

## Add a test — `author_new_test`

New `tests/<domain>/<name>.test.ts` with a unique dotted id, a Zod `params` builder, and
declarative asserts. Then `pnpm compile` (proves it normalizes) and `run_test`.

The Zod schema in `packages/schema/src/test.ts` is the real contract — a shape it rejects is not a
test, however plausible it reads. Prefer fixing the authored value over reaching for `fn`.

## Edit a test

Change the `*.test.ts` declaratively. `tsc` plus `pnpm compile` catch the regressions; there is no
separate validation pass to remember.

## Compose a suite — `generate_suite`

Reuse before authoring: `list_tests`, then `useTest`/`useStep`. Make dependencies explicit with
`needs`, and address values across branches as `{{nodes.X.var}}`. Suites embed tests **by
reference**, never by copy.

## Migrate from Insomnia — `import_insomnia_collection`

`pnpm atp import <file.yaml>` scaffolds drafts plus a `MIGRATION.md`. The deterministic transform
lives in `packages/cli/src/import.ts`; the agent's job is the part the transform cannot do:

- Replace every `__TODO_CHAIN__` placeholder with a real response-ref. Until that is done, a
  chained request hits a literal `__TODO_CHAIN__` path segment, 404s, and still satisfies the
  scaffolded `status < 500` assertion — a suite that passes while testing nothing.
- Strengthen those scaffolded assertions into golden-master parity checks (`goldenAssertions` in
  `packages/cli/src/golden.ts`).

## Triage a failure — `triage_failure`

`get_report {runId}` plus the `run://{runId}/trace.json` resource, then name the hypothesis —
auth, schema drift, or timeout — before changing anything. Fix or quarantine, then re-run.

## Regenerate reports — `regenerate_reports`

`list_runs`, then `get_report {runId, format}` per run. This is a pure re-render of stored
`ExecutionResult`s; nothing re-executes, so it is always safe to run.
