---
paths:
  - "packages/schema/**/*.ts"
---

# `@atp/schema` — the representation layer

**Authored vs. normalized is the core mental model.** The Zod schemas exported here describe
the *normalized, serializable* form — what lands in the manifest. The *authored* forms (types
at the bottom of `packages/schema/src/test.ts`) carry what cannot serialize: `fn` assertion
predicates and a `params` builder.

The normalizer (`packages/engine/src/normalize.ts`) replaces each `fn` with `{ fnHash }` (a
content hash computed by the **engine**, not here — this package only models the marker) and
the `params` builder with a JSON Schema. Normalized assertion is
`declarativeAssertionSchema | fnAssertionSchema`. **The manifest carries no functions.**

**Change a representation here first and let consumers adapt — never fork the shape** (ADR-003).

## Rules that live here

- **Unified node model:** a test's `steps` and a suite's `nodes` are the same `stepSchema`
  (which includes `needs: string[]`, default `[]`). `suiteNodeSchema` aliases `stepSchema`;
  the manifest entry's `nodes` reuses it. Tests and suites normalize to one array-of-nodes shape.
- **Where validation goes:** cheap structural guards live in the `defineX` helpers (fail fast
  where the value is authored); shape validation lives in Zod `.refine`s (fail at parse time).
- **Ids are addressing keys** — `needs` edges, `{{nodes.X.*}}` templates, manifest lookup — so
  `testCaseSchema.steps`, `suiteSchema.nodes`, `manifestEntrySchema.nodes`, and
  `manifestSchema.entries` all `.refine(uniqueById, …)` (helper in `util.ts`). Duplicates are
  rejected at parse time rather than silently mis-binding downstream.
- **Zod 4.** `z.toJSONSchema()` is native — no `zod-to-json-schema` dep. `deriveParamsSchema`
  passes `io: "input"` so a param with `.default()` is **optional** in the derived tool-input
  schema. ISO timestamps use `z.iso.datetime({ offset: true })` so `+02:00` stamps (Postgres
  `timestamptz`) parse as well as `Z`.
- **Config changes are additive** — `configSchema` is consumed by the CLI and the MCP server;
  add optional fields, don't repurpose existing ones.

## Conventions

TypeScript strict + ESM. The base tsconfig sets `verbatimModuleSyntax`, `isolatedModules`, and
`noUncheckedIndexedAccess` — use `import type` for type-only imports and treat indexed access
as possibly-`undefined`.
