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
 * text mirror). */
function payload<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

/** Concatenate the text blocks of a tool result (report tools return rendered text). */
function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.map((b) => b.text ?? "").join("");
}

/** Run `alpha.create-widget` against `baseUrl` and return its runId. */
async function runCreateWidget(conn: ConnectedClient, baseUrl: string): Promise<string> {
  const res = await conn.client.callTool({
    name: "run_test",
    arguments: { id: "alpha.create-widget", env: { baseUrl } },
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
      "alpha.create-widget",
      "alpha.widget-lifecycle",
      "beta.read-widget",
    ]);
    // Catalog view carries the fields agents filter/route on.
    const widget = entries.find((e) => e.id === "alpha.create-widget");
    expect(widget).toMatchObject({ kind: "test", isLongRunning: false });
  });

  it("pages the catalog with an opaque cursor and stops when exhausted", async () => {
    // The corpus is documented to grow to thousands of entries; an unbounded array lands
    // whole in a calling agent's context window.
    const first = await conn.client.callTool({ name: "list_tests", arguments: { limit: 2 } });
    const page1 = payload<{ entries: { id: string }[]; nextCursor?: string }>(first);
    expect(page1.entries.map((e) => e.id)).toEqual([
      "alpha.create-widget",
      "alpha.widget-lifecycle",
    ]);
    expect(page1.nextCursor).toBeTruthy();

    const second = await conn.client.callTool({
      name: "list_tests",
      arguments: { limit: 2, cursor: page1.nextCursor },
    });
    const page2 = payload<{ entries: { id: string }[]; nextCursor?: string }>(second);
    expect(page2.entries.map((e) => e.id)).toEqual(["beta.read-widget"]);
    // Absent nextCursor is the protocol's "end of results".
    expect(page2.nextCursor).toBeUndefined();
  });

  it("advertises the read-only tools as read-only", async () => {
    // Both destructiveHint and openWorldHint default to *true*, so an unannotated reader is
    // indistinguishable from a tool that mutates a remote system.
    const { tools } = await conn.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_tests?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.get_report?.annotations).toMatchObject({ readOnlyHint: true });
    // The run tools keep the conservative defaults — they really do reach a live SUT.
    expect(byName.run_test?.annotations?.readOnlyHint).toBeUndefined();
  });

  it("declares an outputSchema for the tools with a stable result shape", async () => {
    // Without one a client can only discover the payload shape by calling the tool and
    // inspecting what comes back. The SDK also validates every non-error result against it,
    // so the declaration is enforced rather than documentation that can drift.
    const { tools } = await conn.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["list_tests", "describe_test", "run_test", "list_runs"]) {
      expect(byName[name]?.outputSchema, `${name} must declare an outputSchema`).toMatchObject({
        type: "object",
      });
    }
    // The declared shape names the field a caller actually reads.
    expect(Object.keys(byName.list_tests?.outputSchema?.properties ?? {})).toContain("entries");
    expect(Object.keys(byName.run_test?.outputSchema?.properties ?? {})).toContain("run");
  });

  it("filters by tag", async () => {
    const res = await conn.client.callTool({
      name: "list_tests",
      arguments: { tags: ["alpha"] },
    });
    const { entries } = payload<{ entries: { id: string }[] }>(res);
    expect(entries.map((e) => e.id).sort()).toEqual([
      "alpha.create-widget",
      "alpha.widget-lifecycle",
    ]);
  });

  it("filters by kind and owner", async () => {
    const suites = payload<{ entries: { id: string }[] }>(
      await conn.client.callTool({ name: "list_tests", arguments: { kind: "suite" } }),
    );
    expect(suites.entries.map((e) => e.id)).toEqual(["alpha.widget-lifecycle"]);
    const owned = payload<{ entries: { id: string }[] }>(
      await conn.client.callTool({ name: "list_tests", arguments: { owner: "team-beta" } }),
    );
    expect(owned.entries.map((e) => e.id)).toEqual(["beta.read-widget"]);
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
      arguments: { id: "alpha.create-widget" },
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
    expect(entry.id).toBe("alpha.create-widget");
    expect(entry.kind).toBe("test");
    // The detail view carries what the catalog omits: the executable node graph, the
    // params JSON Schema, the resolved env, and the authored source path.
    expect(entry.nodes.map((n) => n.id)).toEqual(["create"]);
    expect(entry.paramsSchema?.type).toBe("object");
    expect(entry.env).toMatchObject({ baseUrl: expect.any(String) });
    expect(entry.sourcePath).toBe("tests/alpha/create-widget.test.ts");
  });

  it("errors on an unknown id", async () => {
    const res = await conn.client.callTool({
      name: "describe_test",
      arguments: { id: "nope.missing" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("nope.missing");
  });

  it("distinguishes a not-found from an internal fault with a machine-readable code", async () => {
    // Every throw used to be a plain Error, so a caller could only tell "unknown id" from
    // "the server broke" by pattern-matching prose. The code is the stable contract; the
    // message text stays exactly as it was for clients that only read `content`.
    const res = await conn.client.callTool({
      name: "describe_test",
      arguments: { id: "nope.missing" },
    });
    expect(res.structuredContent).toMatchObject({
      error: { code: "not_found", message: expect.stringContaining("nope.missing") },
    });
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
      arguments: { id: "alpha.create-widget", env: { baseUrl: sut.url } },
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
    expect(run.entryId).toBe("alpha.create-widget");
    expect(run.status).toBe("passed");
    expect(run.runId).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // a uuid
    expect(run.metrics).toMatchObject({ totalSteps: 1, passedSteps: 1 });
    // The canonical trace was persisted; its uri points at the run's trace.json.
    expect(run.artifactUri).toContain(`${run.runId}/trace.json`);
  });

  it("forwards the engine's progress ticks when the caller supplies a progressToken", async () => {
    // A sync run blocks the request for its whole duration with no feedback. The engine
    // already emits k/n ticks; without this they stop at the tool boundary and a caller has
    // no way to tell a slow run from a hung one.
    const seen: { progress: number; total?: number }[] = [];
    await conn.client.callTool(
      { name: "run_test", arguments: { id: "alpha.create-widget", env: { baseUrl: sut.url } } },
      undefined,
      { onprogress: (p) => seen.push({ progress: p.progress, total: p.total }) },
    );
    // One node in this fixture, so exactly one tick — and it must carry the plan total, or a
    // client cannot render a proportion.
    expect(seen).toEqual([{ progress: 1, total: 1 }]);
  });

  it("links the run's trace as a readable resource, not just an opaque uri", async () => {
    // `artifactUri` is a storage pointer (file:// / s3://) the client has no way to fetch.
    // A resource_link names a uri this server actually serves, so an agent can follow it
    // instead of guessing the `run://` template. Additive: `artifactUri` is untouched.
    const res = await conn.client.callTool({
      name: "run_test",
      arguments: { id: "alpha.create-widget", env: { baseUrl: sut.url } },
    });
    const { run } = payload<{ run: { runId: string; artifactUri: string } }>(res);
    const links = (
      res as { content: { type: string; uri?: string; name?: string }[] }
    ).content.filter((b) => b.type === "resource_link");
    expect(links.map((l) => l.uri)).toEqual([`run://${run.runId}/trace.json`]);
    expect(run.artifactUri).toContain(`${run.runId}/trace.json`);

    // The link resolves — following it returns this run's trace.
    const read = await conn.client.readResource({ uri: links[0]!.uri! });
    const trace = JSON.parse((read.contents[0] as { text: string }).text) as { runId: string };
    expect(trace.runId).toBe(run.runId);
  });

  it("rejects suites — inline run_test is for a single test (async suites go through run_suite)", async () => {
    const res = await conn.client.callTool({
      name: "run_test",
      arguments: { id: "alpha.widget-lifecycle", env: { baseUrl: sut.url } },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content).toLowerCase()).toContain("suite");
  });

  it("auto-tasks long-running tests, but errors without a run database (async needs durable state)", async () => {
    // No db is configured here, so the auto-task path can't enqueue — run_test surfaces a
    // clear error pointing at the async/database requirement (the enqueue path itself is
    // covered end-to-end by the pg-gated async-lifecycle suite).
    const base = await makeTestContext();
    const manifest = {
      ...base.manifest,
      entries: base.manifest.entries.map((e) =>
        e.id === "alpha.create-widget" ? { ...e, isLongRunning: true } : e,
      ),
    };
    const c = await connectClient({ ...base, manifest });
    const res = await c.client.callTool({
      name: "run_test",
      arguments: { id: "alpha.create-widget", env: { baseUrl: sut.url } },
    });
    expect(res.isError).toBe(true);
    const msg = JSON.stringify(res.content).toLowerCase();
    expect(msg).toContain("long-running");
    expect(msg).toContain("database");
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
    const runId = await runCreateWidget(conn, sut.url);
    const md = textOf(
      await conn.client.callTool({ name: "get_report", arguments: { runId, format: "md" } }),
    );
    expect(md).toContain(`# Report — alpha.create-widget`);
    expect(md).toContain("**Status:** passed");
    expect(md).toContain(runId);
  });

  it("defaults to markdown and honours other formats", async () => {
    const runId = await runCreateWidget(conn, sut.url);
    // No format → markdown.
    expect(
      textOf(await conn.client.callTool({ name: "get_report", arguments: { runId } })),
    ).toContain("# Report — alpha.create-widget");
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
    // history is just empty.
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

  it("reports a malformed cursor as a client error, not an internal fault", async () => {
    // The taxonomy's own docstring names "bad cursor" as the canonical invalid_argument.
    // The catalog cursor already reported it that way; a store-backed cursor threw a plain
    // Error, which classify() can only bucket as `internal` — telling the caller the server
    // broke when in fact the caller sent garbage.
    const res = await conn.client.callTool({
      name: "list_runs",
      arguments: { cursor: "not-a-real-cursor" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ error: { code: "invalid_argument" } });
  });

  it("records inline runs and lists them, filterable by entry", async () => {
    const r1 = await runCreateWidget(conn, sut.url);
    const r2 = await runCreateWidget(conn, sut.url);
    const { runs } = payload<{
      runs: { runId: string; entryId: string; status: string; startedAt: string }[];
    }>(
      await conn.client.callTool({
        name: "list_runs",
        arguments: { entryId: "alpha.create-widget" },
      }),
    );
    const ids = runs.map((r) => r.runId);
    expect(ids).toContain(r1);
    expect(ids).toContain(r2);
    expect(runs.every((r) => r.entryId === "alpha.create-widget")).toBe(true);
    expect(runs.every((r) => r.status === "passed")).toBe(true);
    // The row's Date columns are serialized to ISO strings for JSON transport.
    const first = runs.find((r) => r.runId === r1);
    expect(typeof first?.startedAt).toBe("string");
  });

  it("filters out non-matching entries", async () => {
    await runCreateWidget(conn, sut.url);
    const { runs } = payload<{ runs: unknown[] }>(
      await conn.client.callTool({ name: "list_runs", arguments: { entryId: "nope.absent" } }),
    );
    expect(runs).toEqual([]);
  });

  it("pages history with a cursor, reaching runs past the first page", async () => {
    // With only `limit` and no cursor, anything older than the newest N was unreachable
    // through the surface entirely.
    const recorded = [
      await runCreateWidget(conn, sut.url),
      await runCreateWidget(conn, sut.url),
      await runCreateWidget(conn, sut.url),
    ];

    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const page = payload<{ runs: { runId: string }[]; nextCursor?: string }>(
        await conn.client.callTool({ name: "list_runs", arguments: { limit: 2, cursor } }),
      );
      expect(page.runs.length).toBeLessThanOrEqual(2);
      walked.push(...page.runs.map((r) => r.runId));
      cursor = page.nextCursor;
    } while (cursor);

    for (const runId of recorded) expect(walked).toContain(runId);
    expect(new Set(walked).size).toBe(walked.length); // no row served twice
  });
});
