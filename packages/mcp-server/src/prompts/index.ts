import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * MCP prompts — the agent workflows encoded once so behavior is reusable, not re-prompted
 * (research §8.3, §13). Each prompt renders a concrete instruction template referencing the
 * real tool/CLI surface (`atp import`, `list_tests`, `run_test`, `get_report`, the `run://`
 * resources) and the repo conventions (`defineTest`/`defineSuite`, `tests/_shared/*`, the
 * compile + typecheck gate), so an agent can execute the procedure without re-deriving it.
 *
 * Prompts are pure guidance and carry no run state, so they are always registered — on the
 * sync surface as well as the async one.
 */

/** Wrap instruction text as a single user message (the SEP prompt shape the SDK expects). */
function userPrompt(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

/** `import_insomnia_collection` — Insomnia YAML → compiling `defineTest`/`defineSuite` drafts. */
function registerImportInsomnia(server: McpServer): void {
  server.registerPrompt(
    "import_insomnia_collection",
    {
      title: "Import an Insomnia collection",
      description:
        "Convert an Insomnia v5 YAML export into defineTest/defineSuite modules following repo conventions, with a golden-master parity plan.",
      argsSchema: {
        path: z.string().describe("Path to the Insomnia v5 YAML export to convert."),
      },
    },
    ({ path }) =>
      userPrompt(
        `Migrate the Insomnia collection at \`${path}\` into the IR (research §13.1, §19). Insomnia YAML is a *source*, never wired into MCP directly.

1. Run the deterministic scaffolder: \`atp import ${path}\`. It maps the clean parts — each request → a \`defineTest\` step, each folder → a \`defineSuite\`, \`environments.data\` → \`tests/_shared/env/*\`, bearer auth → \`tests/_shared/auth/*\`, and \`{{ _.var }}\` tags → \`{{env.*}}\`/\`{{secrets.*}}\`. It leaves an \`__TODO_CHAIN__\` placeholder plus a \`// TODO(migrate)\` comment wherever a request used an Insomnia response-ref tag.
2. Refine each generated draft under \`tests/<domain>/\`:
   - Wire every \`__TODO_CHAIN__\`: add an \`extract\` (e.g. \`{ as: "id", from: "body.id" }\`) on the source node and reference it here as \`{{nodes.<sourceNodeId>.<var>}}\`, and add the \`needs\` edge. Prefer \`{{nodes.X.var}}\` over \`{{vars.*}}\` across parallel branches.
   - Reuse before authoring: if a request already exists as a test, compose it with \`useTest\`/\`useStep\` rather than duplicating.
   - Replace the placeholder \`assert: [{ path: "status", op: "lt", value: 500 }]\` with real parity assertions (next step).
3. Golden-master parity (regression safety): run each migrated entry once against the SUT (\`atp run <id>\`), capture the baseline response, and add assertions that prove it reproduces the baseline — the exact status plus a shape check per key field. Do not over-assert run-to-run-variable values (tokens, ids, timestamps): assert their type, not their value.
4. Validation gate: \`pnpm compile\` and \`pnpm typecheck\` must pass. Record the Insomnia-id → IR-id mapping in \`MIGRATION.md\` and retire the Insomnia file once the namespace reaches parity.`,
      ),
  );
}

/** `author_new_test` — scaffold a new test from a description or an OpenAPI operation. */
function registerAuthorNewTest(server: McpServer): void {
  server.registerPrompt(
    "author_new_test",
    {
      title: "Author a new test",
      description:
        "Scaffold a new defineTest from a natural-language description or an OpenAPI operation, following repo conventions.",
      argsSchema: {
        description: z
          .string()
          .describe("What the test should verify (NL) — the behavior under test."),
        openapi: z
          .string()
          .optional()
          .describe(
            "Optional: an OpenAPI operation (method + path or a snippet) to derive the request from.",
          ),
      },
    },
    ({ description, openapi }) =>
      userPrompt(
        `Author a new test that verifies: ${description}${openapi ? `\n\nDerive the request from this OpenAPI operation:\n${openapi}` : ""}

Follow the repo conventions (research §7.1):
- Create \`tests/<domain>/<name>.test.ts\` exporting \`export default defineTest({ ... })\`.
- Give it a unique dotted \`id\` (\`<domain>.<name>\`), \`version: 1\`, a \`title\`, \`tags\`, and an \`owner\`. Ids are addressing keys and must be unique.
- Point the request at \`{{env.baseUrl}}\`; source the env from \`tests/_shared/env/*\` (reuse an existing one if it fits). Put variable inputs in a Zod \`params\` builder (\`params: (z) => z.object({ ... })\`) — its JSON Schema becomes the \`run_test\` input schema. Never bake secrets in; reference \`{{secrets.*}}\`.
- Assert with the declarative operators (\`eq\`, \`contains\`, \`isString\`, \`jsonSchema\`, …); reach for an \`fn\` predicate only for logic they cannot express.
- Reuse before authoring: shared steps/auth live in \`tests/_shared/{steps,auth}\`.
- Gate: \`pnpm compile\` + \`pnpm typecheck\`, then \`run_test\` to see it pass.`,
      ),
  );
}

/** `triage_failure` — from a failed runId to a root-cause hypothesis + a fix or quarantine. */
function registerTriageFailure(server: McpServer): void {
  server.registerPrompt(
    "triage_failure",
    {
      title: "Triage a failing run",
      description:
        "Given a failed runId, fetch the report + trace, hypothesize a root cause, and propose a fix or a quarantine.",
      argsSchema: {
        runId: z.string().describe("The failed run id to triage."),
      },
    },
    ({ runId }) =>
      userPrompt(
        `Triage failed run \`${runId}\` (research §13.2, §14).

1. Fetch the evidence: call \`get_report\` with \`{ runId: "${runId}" }\` (markdown) for the assertion table + failure diagnostics, and read the full trace at \`run://${runId}/trace.json\` for the redacted request/response of the failing node.
2. Form a hypothesis from the failure shape — distinguish: auth (401/403 → wrong/expired token or missing \`authRef\`), schema mismatch (2xx but an assertion on \`body.*\` fails → the SUT contract changed), timeout/eventual-consistency (needs \`poll\`/\`retry\`), or a genuine SUT regression.
3. Decide and act:
   - Test is wrong / SUT contract legitimately changed → edit the \`*.test.ts\` declaratively, then re-run with \`run_test\`.
   - SUT is wrong → summarize the failing request/response as a bug for the service owner; do not weaken the assertion to make it pass.
   - Flaky and blocking → quarantine by removing the \`smoke\` tag (so CI's smoke selection skips it) and note why.
4. Verify the fix: \`run_test\` again and confirm the assertions pass.`,
      ),
  );
}

/** `generate_suite` — compose existing tests into a new suite; reuse first, forbid duplication. */
function registerGenerateSuite(server: McpServer): void {
  server.registerPrompt(
    "generate_suite",
    {
      title: "Generate a suite",
      description:
        "Compose existing tests/steps into a new suite (defineSuite), reusing by reference and forbidding duplication.",
      argsSchema: {
        goal: z.string().describe("The end-to-end scenario the suite should cover."),
        tags: z
          .string()
          .optional()
          .describe("Optional comma-separated tags to seed the search for reusable tests."),
      },
    },
    ({ goal, tags }) =>
      userPrompt(
        `Compose a suite for: ${goal} (research §7.2, §12).

1. Reuse first (this is mandatory — do not copy-paste request logic): call \`list_tests\`${
          tags
            ? ` (e.g. \`{ tags: [${tags
                .split(",")
                .map((t) => JSON.stringify(t.trim()))
                .join(", ")}] }\`)`
            : ""
        } to find existing tests/steps that cover parts of the scenario. Inspect candidates with \`describe_test\`.
2. Create \`tests/<domain>/<name>.suite.ts\` exporting \`export default defineSuite({ ... })\`. Compose existing pieces by reference — \`useTest(loginTest, { params })\` for a whole test, \`useStep(sharedStep, { with })\` for a shared step — and only write an inline node for genuinely new requests.
3. Make the DAG explicit with \`needs\`; publish values with \`extract\` and address them downstream as \`{{nodes.<id>.<var>}}\` (reliable across parallel branches, unlike \`{{vars.*}}\`). Use \`poll: { untilAssertPasses: true, ... }\` for eventual consistency.
4. Gate: \`pnpm compile\` + \`pnpm typecheck\`. A suite whose \`timeoutMs\` exceeds 30s is long-running and runs via \`run_suite\` (an async MCP Task).`,
      ),
  );
}

/** `regenerate_reports` — re-render stored ExecutionResults into a new format. */
function registerRegenerateReports(server: McpServer): void {
  server.registerPrompt(
    "regenerate_reports",
    {
      title: "Regenerate reports",
      description:
        "Re-render stored run history into a new report format via list_runs + get_report.",
      argsSchema: {
        format: z.string().describe("Target format: md, html, junit, json, or summary."),
        entryId: z.string().optional().describe("Optional: only runs of this test/suite id."),
        since: z
          .string()
          .optional()
          .describe("Optional: ISO-8601 instant; only runs at or after it."),
      },
    },
    ({ format, entryId, since }) => {
      const filter = [
        entryId ? `entryId: ${JSON.stringify(entryId)}` : null,
        since ? `since: ${JSON.stringify(since)}` : null,
      ].filter(Boolean);
      const filterText = filter.length ? `{ ${filter.join(", ")} }` : "{}";
      return userPrompt(
        `Re-render stored run history into the \`${format}\` format (research §13.2, §14). Reports derive from one canonical \`ExecutionResult\`, so any historical run can be re-rendered without re-executing it.

1. Select the runs: call \`list_runs\` with \`${filterText}\` (add \`status\`/\`limit\` to narrow). Each row carries a \`runId\`.
2. For each \`runId\`, call \`get_report\` with \`{ runId, format: "${format}" }\` to render the stored result in the target format.
3. Collect the rendered outputs (write them to disk or hand them to the caller). Nothing is re-run — this is a pure re-render of persisted results, so it is safe and cheap.`,
      );
    },
  );
}

/** Register all five workflow prompts on the server (research §8.3). */
export function registerPrompts(server: McpServer): void {
  registerImportInsomnia(server);
  registerAuthorNewTest(server);
  registerTriageFailure(server);
  registerGenerateSuite(server);
  registerRegenerateReports(server);
}
