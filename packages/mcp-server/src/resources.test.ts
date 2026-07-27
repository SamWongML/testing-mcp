import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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
      "alpha.create-widget",
      "alpha.widget-lifecycle",
      "beta.read-widget",
    ]);
  });

  it("pages the catalog at test://catalog/{cursor} without colliding with test://{id}", async () => {
    // The fixture corpus fits in one page, so drive the template directly with a cursor
    // pointing past the first entry — the same shape a real nextCursor has.
    const cursor = Buffer.from("alpha.create-widget", "utf8").toString("base64url");
    const res = await conn.client.readResource({ uri: `test://catalog/${cursor}` });
    const parsed = JSON.parse(first(res).text) as { entries: { id: string }[] };
    expect(parsed.entries.map((e) => e.id)).toEqual(["alpha.widget-lifecycle", "beta.read-widget"]);
  });

  it("serves one entry's detail at test://{id}", async () => {
    const res = await conn.client.readResource({ uri: "test://alpha.create-widget" });
    const parsed = JSON.parse(first(res).text) as {
      entry: { id: string; nodes: { id: string }[] };
    };
    expect(parsed.entry.id).toBe("alpha.create-widget");
    expect(parsed.entry.nodes.map((n) => n.id)).toEqual(["create"]);
  });

  it("errors on an unknown test id", async () => {
    await expect(conn.client.readResource({ uri: "test://nope.missing" })).rejects.toThrow(
      /nope\.missing/,
    );
  });

  it("reports an unknown id as InvalidParams, not a blanket InternalError", async () => {
    // The identical `findEntry` throw reaches a client two ways: as an `isError` result from
    // describe_test, and as a JSON-RPC error here. It used to arrive as -32603 InternalError,
    // which tells a client "the server is broken" about its own bad id — and is
    // indistinguishable from a genuine fault.
    const err = await conn.client
      .readResource({ uri: "test://nope.missing" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    // The taxonomy code rides in `data`, so a structured client gets the same machine code
    // it would get from the tool surface.
    expect((err as McpError).data).toMatchObject({ code: "not_found" });
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
      arguments: { id: "alpha.create-widget", env: { baseUrl: sut.url } },
    });
    return (res as unknown as { structuredContent: { run: { runId: string } } }).structuredContent
      .run.runId;
  }

  it("serves report.md and trace.json for a completed run", async () => {
    const runId = await run();

    const md = first(await conn.client.readResource({ uri: `run://${runId}/report.md` }));
    expect(md.mimeType).toBe("text/markdown");
    expect(md.text).toContain("# Report — alpha.create-widget");

    const trace = first(await conn.client.readResource({ uri: `run://${runId}/trace.json` }));
    expect(trace.mimeType).toBe("application/json");
    const parsed = JSON.parse(trace.text) as { runId: string; entryId: string };
    expect(parsed.runId).toBe(runId);
    expect(parsed.entryId).toBe("alpha.create-widget");
  });

  it("errors on an unknown run", async () => {
    await expect(
      conn.client.readResource({ uri: "run://00000000-0000-0000-0000-000000000000/trace.json" }),
    ).rejects.toThrow();
  });
});
