import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { initTelemetry, RUN_STATE_ATTRIBUTE, withSpan, type Telemetry } from "./telemetry";

/**
 * Tracing + metrics. Spans nest MCP-call → run → SUT-call so a run is traceable
 * end to end; the run/queue metrics feed dashboards + autoscaling. Both are read back through
 * in-memory exporters — no collector needed offline.
 */
describe("telemetry", () => {
  let spanExporter: InMemorySpanExporter;
  let metricExporter: InMemoryMetricExporter;
  let tel: Telemetry;

  beforeAll(() => {
    spanExporter = new InMemorySpanExporter();
    metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    tel = initTelemetry({
      serviceName: "atp-test",
      spanExporter,
      metricReader: new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 24 * 60 * 60 * 1000, // never auto-export; we force-flush
      }),
    });
  });
  afterAll(async () => {
    await tel.shutdown();
  });

  it("nests spans so a run is traceable MCP-call → run → SUT-call", async () => {
    spanExporter.reset();
    await withSpan(tel.tracer, "mcp.call run_test", async () => {
      await withSpan(tel.tracer, "run identity.login", async () => {
        await withSpan(tel.tracer, "sut GET /invoices/1", () => undefined, {
          attributes: { "http.method": "GET" },
        });
      });
    });

    const spans = spanExporter.getFinishedSpans();
    const byName = (n: string) => spans.find((s) => s.name === n);
    const call = byName("mcp.call run_test");
    const run = byName("run identity.login");
    const sut = byName("sut GET /invoices/1");
    expect(call && run && sut).toBeTruthy();
    // Same trace, correct parent chain.
    expect(run!.spanContext().traceId).toBe(call!.spanContext().traceId);
    expect(run!.parentSpanContext?.spanId).toBe(call!.spanContext().spanId);
    expect(sut!.parentSpanContext?.spanId).toBe(run!.spanContext().spanId);
    expect(sut!.attributes["http.method"]).toBe("GET");
  });

  it("records the exception and rethrows when the span body throws", async () => {
    spanExporter.reset();
    await expect(
      withSpan(tel.tracer, "run boom", () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");
    const span = spanExporter.getFinishedSpans().find((s) => s.name === "run boom");
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("records run + queue-depth metrics readable via the exporter", async () => {
    tel.metrics.recordRun("passed", 1500);
    tel.metrics.recordRun("failed", 900);
    tel.metrics.recordAssertionFailure("identity.login");
    tel.metrics.setQueueDepth(4);
    await tel.forceFlush();

    const collected = metricExporter.getMetrics();
    const metrics = collected.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
    const byName = (n: string) => metrics.find((m) => m.descriptor.name === n);

    expect(byName("runs_total")).toBeDefined();
    const runsTotal = byName("runs_total")!.dataPoints.reduce(
      (sum, dp) => sum + (dp.value as number),
      0,
    );
    expect(runsTotal).toBe(2);

    const queueDepth = byName("queue_depth")!.dataPoints.at(-1)!.value;
    expect(queueDepth).toBe(4);

    expect(byName("assertion_failures_total")).toBeDefined();
    expect(byName("run_duration_ms")).toBeDefined();
  });

  it("dimensions runs_total by `status` — the key the CloudWatch alarms query", () => {
    // Paired with the assertion in `infra/src/observability-stack.test.ts`. These two must
    // agree on the literal or the alarms silently never fire; nothing else couples them.
    expect(RUN_STATE_ATTRIBUTE).toBe("status");
  });
});
