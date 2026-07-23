# AGENTS.md — the contract for coding agents

This repository is a **test capability platform**: API tests are authored as typed,
declarative TypeScript values, compiled to a normalized JSON manifest, and executed by a
pure in-house DAG engine. You (a coding agent) author and maintain the tests. This file is
the recipe; `CLAUDE.md` is the architecture/invariants guide.

> **Working on the platform itself (packages/tools)?** Read `docs/PROGRESS.md` and
> `docs/implementation-plan.md` first. This file is about authoring **tests** in `tests/`.

## Conventions (discovery is structural — no registration)

- **`tests/<domain>/<name>.test.ts`** — one executable test (a `defineTest` default export).
- **`tests/<domain>/<name>.suite.ts`** — one composition (a `defineSuite` default export).
- **Folder = tag = ownership.** A test's domain folder is its namespace; add matching
  `tags` and an `owner`. New domains are new folders.
- **`tests/_shared/`** — reusable building blocks so duplication has nowhere to hide:
  - `env/*.ts` — environment objects (`{{env.*}}` source), e.g. `local`.
  - `auth/*.ts` — reusable auth providers (`bearerAuth`, `apiKeyAuth`, …).
  - `steps/*.ts` — reusable steps embedded by suites via `useStep`.
- Every test/suite has a **stable, globally-unique `id`** and an integer `version`.
- Discovery is `tests/**/*.{test,suite}.ts` → drop a conforming file and `pnpm compile`
  surfaces it. No plugin wiring, no server change.

## Add a test (recipe)

1. Create `tests/<domain>/<name>.test.ts`:

   ```ts
   import { defineTest } from "@atp/engine";
   import { local } from "../_shared/env/local";

   export default defineTest({
     id: "identity.login", // stable, globally unique
     version: 1,
     title: "User can log in and receive a token",
     tags: ["identity", "auth", "smoke"], // folder == first tag
     owner: "team-identity",
     timeoutMs: 15_000, // > 30s ⇒ isLongRunning (an MCP Task by default)
     env: local,
     // params is a Zod schema → the MCP tool input schema is derived from it.
     params: (z) =>
       z.object({
         email: z.string().email().default("qa@example.com"),
         password: z.string().default("qa-password"),
       }),
     steps: [
       {
         id: "post-login",
         request: {
           method: "POST",
           url: "{{env.baseUrl}}/auth/login",
           headers: { "content-type": "application/json" },
           body: { email: "{{params.email}}", password: "{{params.password}}" },
         },
         assert: [
           { path: "status", op: "eq", value: 200 },
           { path: "body.token", op: "isString" },
           // Escape hatch for logic the operators can't express (hashed in the manifest):
           { fn: (res) => (res as { body: { expiresIn: number } }).body.expiresIn > 0 },
         ],
         extract: [{ as: "authToken", from: "body.token" }], // publish to the var bag
         retry: { max: 2, backoffMs: 500, on: ["network", "5xx"] },
       },
     ],
   });
   ```

2. `pnpm typecheck` (types are the guardrail) and `pnpm compile` (Zod-validates + emits
   the manifest). `pnpm atp run identity.login` runs it against the local mock SUT.

## Compose a suite (reuse first — never copy)

```ts
import { defineSuite, useStep, useTest } from "@atp/engine";
import { local } from "../_shared/env/local";
import { createOrder } from "../_shared/steps/create-order";
import login from "../identity/login.test";

export default defineSuite({
  id: "billing.e2e-refund",
  version: 1,
  tags: ["billing", "e2e"],
  owner: "team-billing",
  timeoutMs: 120_000,
  env: local,
  nodes: {
    // A DAG: `needs` are the edges; `extract` publishes; later nodes read {{nodes.X.var}}.
    auth: useTest(login, { params: { email: "billing-bot@example.com" } }),
    order: useStep(createOrder, { needs: ["auth"], with: { token: "{{nodes.auth.authToken}}" } }),
    refund: {
      needs: ["order"],
      request: { method: "POST", url: "{{env.baseUrl}}/payments/{{nodes.order.paymentId}}/refund" },
      assert: [{ path: "status", op: "eq", value: 202 }],
      extract: [{ as: "refundId", from: "body.id" }],
    },
    verify: {
      needs: ["refund"],
      request: { method: "GET", url: "{{env.baseUrl}}/ledger/refunds/{{nodes.refund.refundId}}" },
      assert: [{ path: "body.status", op: "eq", value: "settled" }],
      poll: { untilAssertPasses: true, intervalMs: 3000, maxMs: 90_000 }, // eventual consistency
    },
  },
});
```

Independent branches run in parallel; a node whose dependency failed is skipped.

## `defineTest` / `defineSuite` reference (essentials)

- **Template scopes:** `{{env.*}}` `{{params.*}}` `{{secrets.*}}` `{{matrix.*}}`
  `{{nodes.<id>.<var>}}` (deterministic cross-node) and `{{vars.*}}` (flat, within one
  dependency chain). Secrets stay literal in the manifest — resolved by the engine at run
  time, never baked in.
- **Assertion ops:** `eq neq gt lt contains matches isString isNumber jsonSchema jsonpath`,
  plus a `{ fn, message? }` escape hatch. Assertion `value`s are **not** templated.
- **Per step:** `retry { max, backoffMs, on:[network|4xx|5xx|assertion] }`,
  `poll { untilAssertPasses, intervalMs, maxMs }`, `timeoutMs`, `extract [{ as, from }]`.
- **Matrix:** `matrix: { region: ["us","eu"], tier: ["free","pro"] }` — cartesian expansion;
  each cell is a separate manifest entry `id#region=us,tier=free`. `env` may be a builder
  `(m) => ({...})` resolved per cell.
- **Reuse:** `useTest(test, { params, needs })`, `useStep(step, { with, needs })` embed by
  reference. Shared steps are plain `AuthoredStep` objects in `tests/_shared/steps`.

## CLI (`atp`) — the inner loop

```bash
pnpm compile                 # discover → normalize → dist/manifest.json (+gitSha, hash)
pnpm atp list                # list the catalog  (--tags a,b  --owner o  --kind test|suite)
pnpm atp run <id>            # run in-process against the local mock SUT
pnpm atp run <id> --params '{"email":"x@y.z"}' --env local
pnpm atp validate            # compile in-memory; fail on any bad test
```

`atp run` boots a local mock SUT (an ephemeral port) and points `{{env.baseUrl}}` at it, so
the corpus runs fully offline. Set `ATP_BASE_URL` to run against a real endpoint instead.

## Rules of the road

- **Types + `tsc` are the gate.** `pnpm typecheck` must be clean; a malformed test fails
  `pnpm compile` (Zod validation) and CI, never reaching the manifest.
- **Never duplicate.** Reuse `_shared/*` and `useTest`/`useStep`. If you're copying a
  request, extract a shared step.
- **Don't put platform unit tests in `tests/`.** That directory is the corpus (matched by
  `compile`, not by vitest). Platform tests live beside their source under `packages/**/src`.
