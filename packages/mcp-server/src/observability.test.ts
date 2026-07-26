import { listAudit, type StoreClient } from "@atp/store";
import { context, trace } from "@opentelemetry/api";
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
 * Observability end-to-end — a full async run emits
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

  it("links the worker's run span to the submitting request's trace (one trace, two processes)", async () => {
    // The enqueue→claim hop crosses a process boundary, so without a W3C `traceparent` in the
    // job spec the worker would start a brand-new trace and agent→server→worker→SUT would be
    // three disconnected traces.
    const submitSpan = tel.tracer.startSpan("mcp submit");
    const submitTraceId = submitSpan.spanContext().traceId;
    const { runId } = await context.with(trace.setSpan(context.active(), submitSpan), () =>
      submitRun(ctx, { entryId: "identity.login", env: { baseUrl: sut.url } }),
    );
    submitSpan.end();

    expect(await claimAndRun(ctx, "worker-trace")).toBe(true);
    await tel.forceFlush();

    const runSpan =
      tel && spanExporter.getFinishedSpans().find((s) => s.name === "run identity.login");
    expect(runSpan).toBeDefined();
    expect(runSpan!.attributes["atp.run_id"]).toBe(runId);
    expect(runSpan!.spanContext().traceId).toBe(submitTraceId);
    expect(runSpan!.parentSpanContext?.spanId).toBe(submitSpan.spanContext().spanId);
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

  it("never persists a secret-shaped param to the audit log", async () => {
    // `identity.login` really declares a `password` param, so this is the live leak path, not a
    // hypothetical one.
    const conn = await connectClient(ctx);
    try {
      await conn.client.callTool({
        name: "run_test",
        arguments: {
          id: "identity.login",
          env: { baseUrl: sut.url },
          params: { email: "qa@example.com", password: "s3cr3t-do-not-persist" },
        },
      });
    } finally {
      await conn.close();
    }

    const rows = await listAudit(store.db, { entryId: "identity.login" });
    expect(rows.length).toBeGreaterThan(0);
    const persisted = JSON.stringify(rows.map((r) => r.params));
    expect(persisted).not.toContain("s3cr3t-do-not-persist");
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).toContain("qa@example.com"); // non-secret params stay useful for audit
  });
});
