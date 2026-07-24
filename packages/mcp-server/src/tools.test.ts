import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  connectClient,
  makeTestContext,
  makeTestDb,
  pgAvailable,
  startTestSut,
  type ConnectedClient,
  type TestSut,
} from "./testkit";
import type { StoreClient } from "@atp/store";

/** Read a tool call's structured payload (tools return `structuredContent` + a JSON
 *  text mirror). */
function payload<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

/** Concatenate the text blocks of a tool result (report tools return rendered text). */
function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.map((b) => b.text ?? "").join("");
}

/** Run `identity.login` against `baseUrl` and return its runId. */
async function runLogin(conn: ConnectedClient, baseUrl: string): Promise<string> {
  const res = await conn.client.callTool({
    name: "run_test",
    arguments: { id: "identity.login", env: { baseUrl } },
  });
  return payload<{ run: { runId: string } }>(res).run.runId;
}

describe("list_tests", () => {
  let conn: ConnectedClient;
  beforeEach(async () => {
    conn = await connectClient(await makeTestContext());
  });
  afterEach(async () => {
    await conn.close();
  });

  it("lists the whole corpus, id-sorted", async () => {
    const res = await conn.client.callTool({ name: "list_tests", arguments: {} });
    const { entries } = payload<{
      entries: { id: string; kind: string; isLongRunning: boolean }[];
    }>(res);
    expect(entries.map((e) => e.id)).toEqual([
      "billing.e2e-refund",
      "billing.get-invoice",
      "identity.login",
    ]);
    // Catalog view carries the fields agents filter/route on (§8.2).
    const login = entries.find((e) => e.id === "identity.login");
    expect(login).toMatchObject({ kind: "test", isLongRunning: false });
  });

  it("filters by tag", async () => {
    const res = await conn.client.callTool({
      name: "list_tests",
      arguments: { tags: ["billing"] },
    });
    const { entries } = payload<{ entries: { id: string }[] }>(res);
    expect(entries.map((e) => e.id).sort()).toEqual(["billing.e2e-refund", "billing.get-invoice"]);
  });

  it("filters by kind and owner", async () => {
    const suites = payload<{ entries: { id: string }[] }>(
      await conn.client.callTool({ name: "list_tests", arguments: { kind: "suite" } }),
    );
    expect(suites.entries.map((e) => e.id)).toEqual(["billing.e2e-refund"]);
    const owned = payload<{ entries: { id: string }[] }>(
      await conn.client.callTool({ name: "list_tests", arguments: { owner: "team-identity" } }),
    );
    expect(owned.entries.map((e) => e.id)).toEqual(["identity.login"]);
  });
});

describe("describe_test", () => {
  let conn: ConnectedClient;
  beforeEach(async () => {
    conn = await connectClient(await makeTestContext());
  });
  afterEach(async () => {
    await conn.close();
  });

  it("returns the full manifest entry for an id", async () => {
    const res = await conn.client.callTool({
      name: "describe_test",
      arguments: { id: "identity.login" },
    });
    const { entry } = payload<{
      entry: {
        id: string;
        kind: string;
        sourcePath: string;
        paramsSchema?: { type?: string };
        nodes: { id: string }[];
        env?: Record<string, string>;
      };
    }>(res);
    expect(entry.id).toBe("identity.login");
    expect(entry.kind).toBe("test");
    // The detail view carries what the catalog omits: the executable node graph, the
    // params JSON Schema, the resolved env, and the authored source path (§8.2).
    expect(entry.nodes.map((n) => n.id)).toEqual(["post-login"]);
    expect(entry.paramsSchema?.type).toBe("object");
    expect(entry.env).toMatchObject({ baseUrl: expect.any(String) });
    expect(entry.sourcePath).toBe("tests/identity/login.test.ts");
  });

  it("errors on an unknown id", async () => {
    const res = await conn.client.callTool({
      name: "describe_test",
      arguments: { id: "nope.missing" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("nope.missing");
  });
});

describe("run_test", () => {
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

  it("runs a test inline against the caller's env and reports a passing run", async () => {
    const res = await conn.client.callTool({
      name: "run_test",
      arguments: { id: "identity.login", env: { baseUrl: sut.url } },
    });
    const { run } = payload<{
      run: {
        runId: string;
        entryId: string;
        status: string;
        artifactUri: string;
        metrics: { totalSteps: number; passedSteps: number };
      };
    }>(res);
    expect(run.entryId).toBe("identity.login");
    expect(run.status).toBe("passed");
    expect(run.runId).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // a uuid
    expect(run.metrics).toMatchObject({ totalSteps: 1, passedSteps: 1 });
    // The canonical trace was persisted; its uri points at the run's trace.json.
    expect(run.artifactUri).toContain(`${run.runId}/trace.json`);
  });

  it("rejects suites — inline run_test is for a single test (async suites are P8)", async () => {
    const res = await conn.client.callTool({
      name: "run_test",
      arguments: { id: "billing.e2e-refund", env: { baseUrl: sut.url } },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content).toLowerCase()).toContain("suite");
  });

  it("rejects long-running tests — they exceed the sync budget (async path is P8)", async () => {
    const base = await makeTestContext();
    const manifest = {
      ...base.manifest,
      entries: base.manifest.entries.map((e) =>
        e.id === "identity.login" ? { ...e, isLongRunning: true } : e,
      ),
    };
    const c = await connectClient({ ...base, manifest });
    const res = await c.client.callTool({
      name: "run_test",
      arguments: { id: "identity.login", env: { baseUrl: sut.url } },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content).toLowerCase()).toContain("long-running");
    await c.close();
  });
});

describe("get_report", () => {
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

  it("renders a stored run's markdown report on demand", async () => {
    const runId = await runLogin(conn, sut.url);
    const md = textOf(
      await conn.client.callTool({ name: "get_report", arguments: { runId, format: "md" } }),
    );
    expect(md).toContain(`# Report — identity.login`);
    expect(md).toContain("**Status:** passed");
    expect(md).toContain(runId);
  });

  it("defaults to markdown and honours other formats", async () => {
    const runId = await runLogin(conn, sut.url);
    // No format → markdown.
    expect(
      textOf(await conn.client.callTool({ name: "get_report", arguments: { runId } })),
    ).toContain("# Report — identity.login");
    // JUnit is the same run through a different renderer.
    const junit = textOf(
      await conn.client.callTool({ name: "get_report", arguments: { runId, format: "junit" } }),
    );
    expect(junit).toContain("<testsuite");
  });

  it("errors on an unknown runId", async () => {
    const res = await conn.client.callTool({
      name: "get_report",
      arguments: { runId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.isError).toBe(true);
  });
});

describe("list_runs", () => {
  it("returns an empty history when no database is configured", async () => {
    const conn = await connectClient(await makeTestContext());
    const { runs } = payload<{ runs: unknown[] }>(
      await conn.client.callTool({ name: "list_runs", arguments: {} }),
    );
    // Offline the surface is still callable — inline runs execute and persist artifacts,
    // history is just empty (§8, ADR-002).
    expect(runs).toEqual([]);
    await conn.close();
  });
});

describe.skipIf(!pgAvailable)("list_runs (db-backed)", () => {
  let tdb: StoreClient;
  let sut: TestSut;
  let conn: ConnectedClient;
  beforeEach(async () => {
    tdb = await makeTestDb();
    sut = await startTestSut();
    conn = await connectClient(await makeTestContext({ db: tdb.db }));
  });
  afterEach(async () => {
    await conn.close();
    await sut.close();
    await tdb.close();
  });

  it("records inline runs and lists them, filterable by entry", async () => {
    const r1 = await runLogin(conn, sut.url);
    const r2 = await runLogin(conn, sut.url);
    const { runs } = payload<{
      runs: { runId: string; entryId: string; status: string; startedAt: string }[];
    }>(await conn.client.callTool({ name: "list_runs", arguments: { entryId: "identity.login" } }));
    const ids = runs.map((r) => r.runId);
    expect(ids).toContain(r1);
    expect(ids).toContain(r2);
    expect(runs.every((r) => r.entryId === "identity.login")).toBe(true);
    expect(runs.every((r) => r.status === "passed")).toBe(true);
    // The row's Date columns are serialized to ISO strings for JSON transport.
    const first = runs.find((r) => r.runId === r1);
    expect(typeof first?.startedAt).toBe("string");
  });

  it("filters out non-matching entries", async () => {
    await runLogin(conn, sut.url);
    const { runs } = payload<{ runs: unknown[] }>(
      await conn.client.callTool({ name: "list_runs", arguments: { entryId: "nope.absent" } }),
    );
    expect(runs).toEqual([]);
  });
});
