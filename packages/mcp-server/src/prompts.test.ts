import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectClient, makeTestContext, type ConnectedClient } from "./testkit";

/** Concatenate the text of a prompt's rendered messages. */
function promptText(result: unknown): string {
  const messages = (result as { messages: { content: { type: string; text?: string } }[] })
    .messages;
  return messages.map((m) => m.content.text ?? "").join("\n");
}

describe("MCP prompts (research §8.3, §13)", () => {
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
    // The prompt must point at the golden-master parity + compile gate.
    expect(text).toMatch(/golden|parity/i);
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
