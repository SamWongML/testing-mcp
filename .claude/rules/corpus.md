---
paths:
  - "tests/**/*.ts"
---

# `tests/` — the sample corpus (authored tests, *not* platform unit tests)

These are **product artifacts**: `defineTest`/`defineSuite` values that `pnpm compile`
discovers and normalizes into `dist/manifest.json`. They exercise the platform the way a user
would.

**`tests/**/*.test.ts` is deliberately NOT matched by `vitest.config.ts`** (which includes only
`packages/**/src/**/*.test.ts` and `tools/**/src/**/*.test.ts`). Do not "fix" that by widening
the include — running the corpus under vitest would try to execute authored definitions as
unit tests. Platform unit tests belong beside their source under `src/`.

## Exercising the corpus

```bash
pnpm compile                 # discovery → dist/manifest.json
pnpm atp list                # what the manifest contains
pnpm atp validate            # structural checks + strictness (also a CI step)
pnpm atp run <id>            # execute one entry against the local mock SUT
pnpm atp golden <id> --base-url <url>   # real SUT → paste-ready parity assertions
```

**Strictness (`atp validate`).** It fails on a node that no response could make fail —
an `assert` that is empty, or whose only entries are *range* ops on `status` (`lt`/`gt`) — and
on any surviving `__TODO_CHAIN__` from `atp import`. Pin an exact status (`op: "eq"`) plus at
least one body assertion. A status-only `{ path: "status", op: "eq", value: 204 }` is fine (a
204 DELETE has no body); `status lt 500` is not, because a 404 satisfies it.

## Layout

- `tests/<domain>/<name>.test.ts` — a `defineTest`
- `tests/<domain>/<name>.suite.ts` — a `defineSuite` (DAG over `needs`)
- `tests/_shared/{auth,env,steps}/` — reusable auth profiles, environments, step fragments

## Authoring notes

- Ids are addressing keys (`needs` edges, `{{nodes.<id>.*}}` templates, manifest lookup) and
  must be unique — duplicates are rejected at parse time.
- Template scopes: `{{env.*}}`, `{{params.*}}`, `{{secrets.*}}`, `{{matrix.*}}`,
  `{{nodes.<id>.<var>}}`, `{{vars.*}}`. Across parallel suite branches use
  `{{nodes.<id>.<var>}}` — `{{vars.*}}` is last-writer-wins and only reliable down a single
  dependency chain.
- An `fn` assertion cannot serialize: the normalizer replaces it with `{ fnHash }`, so the
  manifest references it by hash and the authored source is the only place the predicate lives.
