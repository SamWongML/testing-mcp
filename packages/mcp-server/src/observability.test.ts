import { listAudit, type StoreClient } from "@atp/store";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ServerContext } from "./context";
import { createLogger } from "./logging";
import { submitRun, getRun } from "./tasks";
import { initTelemetry, type Telemetry } from "./telemetry";
import {
  connectClient,
  makeTestContext,
  makeTestDb,
  pgAvailable,
  startTestSut,
  type TestSut,
} from "./testkit";
import { claimAndRun } from "./worker";

/**
 * Observability end-to-end (research §15) — the P10 exit criterion that a full async run emits
 * correlated logs + spans + metrics, plus audit rows on run-invoking calls. Gated on
 * `ATP_TEST_DATABASE_URL` (the durable queue is Postgres); telemetry is read back through
 * in-memory exporters, so no collector is needed.
 */
describe.skipIf(!pgAvailable)("observability integration", () => {
  let spanExporter: InMemorySpanExporter;
  let metricExporter: InMemoryMetricExporter;
  let tel: Telemetry;
  let store: StoreClient;
  let sut: TestSut;
  let ctx: ServerContext;
  let logLines: Record<string, unknown>[];

  beforeAll(() => {
    spanExporter = new InMemorySpanExporter();
    metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    tel = initTelemetry({
      serviceName: "atp-itest",
      spanExporter,
      metricReader: new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 24 * 60 * 60 * 1000,
      }),
    });
  });
  afterAll(async () => {
    await tel.shutdown();
  });

  beforeEach(async () => {
    store = await makeTestDb();
    sut = await startTestSut();
    logLines = [];
    const logger = createLogger(
      { level: "debug" },
      { write: (s: string) => void logLines.push(JSON.parse(s) as Record<string, unknown>) },
    );
    ctx = await makeTestContext({ db: store.db, telemetry: tel, logger });
    spanExporter.reset();
  });
  afterEach(async () => {
    await sut.close();
    await store.close();
  });

  it("emits correlated logs, spans (MCP→run→SUT), and metrics for a full async run", async () => {
    const { runId } = await submitRun(ctx, {
      entryId: "billing.e2e-refund",
      env: { baseUrl: sut.url },
    });
    expect(await claimAndRun(ctx, "worker-obs")).toBe(true);
    expect((await getRun(ctx, runId))?.state).toBe("completed");

    await tel.forceFlush();

    // Spans: a run span carrying the runId, with the engine's SUT HTTP calls nested in its trace.
    const spans = spanExporter.getFinishedSpans();
    const runSpan = spans.find((s) => s.name === "run billing.e2e-refund");
    expect(runSpan).toBeDefined();
    expect(runSpan!.attributes["atp.run_id"]).toBe(runId);
    const trace = runSpan!.spanContext().traceId;
    const sutSpans = spans.filter((s) => s.spanContext().traceId === trace && s !== runSpan);
    expect(sutSpans.length).toBeGreaterThan(0); // undici auto-instrumented SUT calls

    // Logs: the terminal line carries the runId correlation id.
    expect(logLines.some((l) => l.runId === runId && l.msg === "run terminal")).toBe(true);

    // Metrics: run + queue-depth signals present.
    const metrics = metricExporter
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
    const names = new Set(metrics.map((m) => m.descriptor.name));
    expect(names.has("runs_total")).toBe(true);
    expect(names.has("queue_depth")).toBe(true);
    expect(names.has("run_duration_ms")).toBe(true);
  });

  it("writes an audit row on a run-invoking call", async () => {
    const conn = await connectClient(ctx);
    try {
      await conn.client.callTool({
        name: "run_test",
        arguments: { id: "identity.login", env: { baseUrl: sut.url }, params: {} },
      });
    } finally {
      await conn.close();
    }

    const rows = await listAudit(store.db);
    expect(
      rows.some(
        (r) =>
          r.action === "run_test" && r.entryId === "identity.login" && r.principal === "anonymous",
      ),
    ).toBe(true);
  });
});
