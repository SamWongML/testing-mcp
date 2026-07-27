import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  connectClient,
  makeTestContext,
  makeTestDb,
  pgAvailable,
  startTestSut,
  type ConnectedClient,
} from "./testkit";

/** Concatenate the text of a prompt's rendered messages. */
function promptText(result: unknown): string {
  const messages = (result as { messages: { content: { type: string; text?: string } }[] })
    .messages;
  return messages.map((m) => m.content.text ?? "").join("\n");
}

describe("MCP prompts", () => {
  let conn: ConnectedClient;
  beforeEach(async () => {
    conn = await connectClient(await makeTestContext());
  });
  afterEach(async () => {
    await conn.close();
  });

  it("advertises all five workflow prompts", async () => {
    const { prompts } = await conn.client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual(
      [
        "author_new_test",
        "generate_suite",
        "import_insomnia_collection",
        "regenerate_reports",
        "triage_failure",
      ].sort(),
    );
  });

  it("renders import_insomnia_collection with the source path and the deterministic → refine flow", async () => {
    const res = await conn.client.getPrompt({
      name: "import_insomnia_collection",
      arguments: { path: "insomnia/petstore.yaml" },
    });
    const text = promptText(res);
    expect(text).toContain("insomnia/petstore.yaml");
    expect(text).toContain("atp import");
    // Parity assertions are *captured*, not hand-written: the prompt must send the agent to
    // `atp golden`, and name `atp validate` as the definition of "migration finished".
    expect(text).toContain("atp golden");
    expect(text).toContain("atp validate");
    expect(text).toContain("compile");
  });

  it("renders author_new_test referencing the defineTest conventions", async () => {
    const res = await conn.client.getPrompt({
      name: "author_new_test",
      arguments: { description: "verify GET /widgets returns 200" },
    });
    const text = promptText(res);
    expect(text).toContain("verify GET /widgets returns 200");
    expect(text).toContain("defineTest");
  });

  it("renders triage_failure keyed to a runId and the report/trace tools", async () => {
    const res = await conn.client.getPrompt({
      name: "triage_failure",
      arguments: { runId: "run-123" },
    });
    const text = promptText(res);
    expect(text).toContain("run-123");
    expect(text).toContain("get_report");
  });

  it("completes prompt arguments from the live catalog and the format list", async () => {
    // Prompt args were free text, so a caller had to already know a valid entry id or format
    // to fill one in. These complete from the same sources the tools validate against, so a
    // completion can never suggest something the tool would then reject.
    const entryId = await conn.client.complete({
      ref: { type: "ref/prompt", name: "regenerate_reports" },
      argument: { name: "entryId", value: "alpha" },
    });
    expect(entryId.completion.values).toEqual(["alpha.create-widget", "alpha.widget-lifecycle"]);

    // Prefix-filtered, not the whole list dumped back.
    const format = await conn.client.complete({
      ref: { type: "ref/prompt", name: "regenerate_reports" },
      argument: { name: "format", value: "j" },
    });
    expect(format.completion.values.sort()).toEqual(["json", "junit"]);

    // Suite composition starts from a tag search, so the tags in the live corpus complete too.
    const tags = await conn.client.complete({
      ref: { type: "ref/prompt", name: "generate_suite" },
      argument: { name: "tags", value: "" },
    });
    expect(tags.completion.values).toContain("alpha");
    expect(tags.completion.values).toContain("beta");
  });

  it("completes triage_failure's runId from recorded history", async () => {
    // The one argument an agent is least able to guess. Empty without a run database, which
    // is the offline case — the prompt still renders, it just cannot suggest.
    const offline = await conn.client.complete({
      ref: { type: "ref/prompt", name: "triage_failure" },
      argument: { name: "runId", value: "" },
    });
    expect(offline.completion.values).toEqual([]);
  });

  it("renders regenerate_reports driving list_runs → get_report in the target format", async () => {
    const res = await conn.client.getPrompt({
      name: "regenerate_reports",
      arguments: { format: "html" },
    });
    const text = promptText(res);
    expect(text).toContain("html");
    expect(text).toContain("list_runs");
    expect(text).toContain("get_report");
  });
});

describe.skipIf(!pgAvailable)("prompt completions (db-backed)", () => {
  it("suggests the ids of runs actually recorded in history", async () => {
    const tdb = await makeTestDb();
    const sut = await startTestSut();
    const conn = await connectClient(await makeTestContext({ db: tdb.db }));
    try {
      const res = await conn.client.callTool({
        name: "run_test",
        arguments: { id: "alpha.create-widget", env: { baseUrl: sut.url } },
      });
      const { runId } = (res as unknown as { structuredContent: { run: { runId: string } } })
        .structuredContent.run;

      const completion = await conn.client.complete({
        ref: { type: "ref/prompt", name: "triage_failure" },
        argument: { name: "runId", value: "" },
      });
      expect(completion.completion.values).toContain(runId);
    } finally {
      await conn.close();
      await sut.close();
      await tdb.close();
    }
  });
});
