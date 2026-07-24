import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  connectClient,
  makeTestContext,
  startTestSut,
  type ConnectedClient,
  type TestSut,
} from "./testkit";

/** First content block of a resource read (uri, text, mimeType). */
function first(res: { contents: { text?: string; mimeType?: string }[] }): {
  text: string;
  mimeType?: string;
} {
  const c = res.contents[0];
  return { text: c?.text ?? "", mimeType: c?.mimeType };
}

describe("catalog + test resources", () => {
  let conn: ConnectedClient;
  beforeEach(async () => {
    conn = await connectClient(await makeTestContext());
  });
  afterEach(async () => {
    await conn.close();
  });

  it("serves the whole catalog at test://catalog", async () => {
    const res = await conn.client.readResource({ uri: "test://catalog" });
    const { text, mimeType } = first(res);
    expect(mimeType).toBe("application/json");
    const parsed = JSON.parse(text) as { entries: { id: string }[] };
    expect(parsed.entries.map((e) => e.id).sort()).toEqual([
      "billing.e2e-refund",
      "billing.get-invoice",
      "identity.login",
    ]);
  });

  it("serves one entry's detail at test://{id}", async () => {
    const res = await conn.client.readResource({ uri: "test://identity.login" });
    const parsed = JSON.parse(first(res).text) as {
      entry: { id: string; nodes: { id: string }[] };
    };
    expect(parsed.entry.id).toBe("identity.login");
    expect(parsed.entry.nodes.map((n) => n.id)).toEqual(["post-login"]);
  });

  it("errors on an unknown test id", async () => {
    await expect(conn.client.readResource({ uri: "test://nope.missing" })).rejects.toThrow(
      /nope\.missing/,
    );
  });
});

describe("run resources", () => {
  let conn: ConnectedClient;
  let sut: TestSut;
  beforeEach(async () => {
    sut = await startTestSut();
    conn = await connectClient(await makeTestContext());
  });
  afterEach(async () => {
    await conn.close();
    await sut.close();
  });

  async function run(): Promise<string> {
    const res = await conn.client.callTool({
      name: "run_test",
      arguments: { id: "identity.login", env: { baseUrl: sut.url } },
    });
    return (res as unknown as { structuredContent: { run: { runId: string } } }).structuredContent
      .run.runId;
  }

  it("serves report.md and trace.json for a completed run", async () => {
    const runId = await run();

    const md = first(await conn.client.readResource({ uri: `run://${runId}/report.md` }));
    expect(md.mimeType).toBe("text/markdown");
    expect(md.text).toContain("# Report — identity.login");

    const trace = first(await conn.client.readResource({ uri: `run://${runId}/trace.json` }));
    expect(trace.mimeType).toBe("application/json");
    const parsed = JSON.parse(trace.text) as { runId: string; entryId: string };
    expect(parsed.runId).toBe(runId);
    expect(parsed.entryId).toBe("identity.login");
  });

  it("errors on an unknown run", async () => {
    await expect(
      conn.client.readResource({ uri: "run://00000000-0000-0000-0000-000000000000/trace.json" }),
    ).rejects.toThrow();
  });
});
