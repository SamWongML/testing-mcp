---
name: atp-workflows
description: The five agent workflows this platform exposes — authoring a test, composing a suite, migrating an Insomnia collection, triaging a failed run, regenerating reports. Use when adding or editing anything under tests/, wiring an imported collection, or investigating a run that failed.
---

# Working the ATP corpus

This is the summary. Each workflow is rendered from an executable MCP prompt in
`packages/mcp-server/src/prompts/index.ts` — open that file when you need the exact rendered text
or are **editing** a workflow, since one edit there changes it for every caller.

Tests are *data*. Authoring one never needs a new MCP tool, only a new file under `tests/`.

## Add or edit a test — `author_new_test`

`tests/<domain>/<name>.test.ts` with a unique dotted id, a Zod `params` builder, and declarative
asserts; then `pnpm compile` and `run_test`. The Zod schema in `packages/schema/src/test.ts` is the
real contract — a shape it rejects is not a test, however plausible it reads. Prefer fixing the
authored value over reaching for `fn`.

`pnpm validate` is the gate that matters: it rejects a node no response could fail. The Stop hook
runs it for you whenever `tests/` changed.

## Compose a suite — `generate_suite`

Reuse before authoring: `list_tests`, then `useTest`/`useStep`. Make dependencies explicit with
`needs`, and address values across branches as `{{nodes.X.var}}` — `{{vars.*}}` is
last-writer-wins and only reliable down a single chain. Suites embed tests **by reference**.

## Migrate from Insomnia — `import_insomnia_collection`

`pnpm atp import <file.yaml>` scaffolds drafts plus a `tests/<domain>/MIGRATION.md` (transform:
`packages/cli/src/import.ts`). The agent's job is what the transform cannot do:

- Replace every `__TODO_CHAIN__` with a real response-ref. Until then the request hits a literal
  `__TODO_CHAIN__` path segment, 404s, and still satisfies the scaffolded `status < 500` — a suite
  that passes while testing nothing.
- Strengthen those scaffolded assertions into golden-master parity checks (`goldenAssertions` in
  `packages/cli/src/golden.ts`).

## Triage a failure — `triage_failure`

`get_report {runId}` plus the `run://{runId}/trace.json` resource. Name the hypothesis — auth,
schema drift, or timeout — before changing anything. Fix or quarantine, then re-run.

## Regenerate reports — `regenerate_reports`

`list_runs`, then `get_report {runId, format}` per run. A pure re-render of stored
`ExecutionResult`s; nothing re-executes, so it is always safe to run.
