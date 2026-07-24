import {
  type Attributes,
  type Meter,
  type Span,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ConsoleMetricExporter,
  type MetricReader,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * OpenTelemetry tracing + metrics (research §15). A single provider pair is installed at boot
 * (`initTelemetry`); {@link withSpan} wraps the MCP-call → run → SUT-call hierarchy so an
 * agent-initiated run is traceable end to end, and {@link RunMetrics} publishes the run/queue
 * signals that drive dashboards and worker autoscaling (`queue_depth`). Exporters are injectable:
 * console locally, OTLP (X-Ray/CloudWatch) in production, in-memory in tests.
 */

/** The run/queue metric instruments (§15). Thin wrappers so callers record intent, not OTel. */
export interface RunMetrics {
  /** One run reached a terminal state — bumps `runs_total{status}` + records `run_duration_ms`. */
  recordRun(status: string, durationMs: number): void;
  /** An assertion failed in `test` — bumps `assertion_failures_total{test}`. */
  recordAssertionFailure(test: string, count?: number): void;
  /** Publish the current queue depth (worker-autoscaling signal). */
  setQueueDepth(depth: number): void;
}

export interface Telemetry {
  tracer: Tracer;
  meter: Meter;
  metrics: RunMetrics;
  /** Flush pending spans + metrics (tests read exporters right after). */
  forceFlush(): Promise<void>;
  /** Tear down providers (release timers) on shutdown. */
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  serviceName: string;
  /** Span destination; defaults to the console exporter. */
  spanExporter?: SpanExporter;
  /** Metric reader; defaults to a periodic console exporter. */
  metricReader?: MetricReader;
}

/** Install the tracer + meter providers and return the handles the server/worker use. */
export function initTelemetry(opts: TelemetryOptions): Telemetry {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName });

  const spanExporter = opts.spanExporter ?? new ConsoleSpanExporter();
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  // Registers the async-hooks context manager so child spans nest under the active span.
  tracerProvider.register();
  // Auto-instrument the engine's undici HTTP calls (via diagnostics_channel) so every request
  // to a system-under-test becomes a child span of the active run span — no engine coupling
  // (the engine stays pure; §20 row 1).
  registerInstrumentations({
    tracerProvider,
    instrumentations: [new UndiciInstrumentation()],
  });

  const metricReader =
    opts.metricReader ??
    new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() });
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });

  const tracer = tracerProvider.getTracer(opts.serviceName);
  const meter = meterProvider.getMeter(opts.serviceName);

  return {
    tracer,
    meter,
    metrics: createRunMetrics(meter),
    forceFlush: async () => {
      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();
    },
    shutdown: async () => {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}

function createRunMetrics(meter: Meter): RunMetrics {
  const runsTotal = meter.createCounter("runs_total", {
    description: "Runs reaching a terminal state",
  });
  const runDuration = meter.createHistogram("run_duration_ms", {
    description: "Run wall-clock duration",
    unit: "ms",
  });
  const assertionFailures = meter.createCounter("assertion_failures_total", {
    description: "Assertion failures by test",
  });
  const queueDepthGauge = meter.createGauge("queue_depth", {
    description: "Ready-to-claim jobs (autoscaling signal)",
  });
  return {
    recordRun(status, durationMs) {
      runsTotal.add(1, { status });
      runDuration.record(durationMs, { status });
    },
    recordAssertionFailure(test, count = 1) {
      assertionFailures.add(count, { test });
    },
    setQueueDepth(depth) {
      queueDepthGauge.record(depth);
    },
  };
}

/**
 * Run `fn` inside a new active span named `name`: child spans created within nest under it, the
 * span records an exception + ERROR status if `fn` throws (then rethrows), and always ends. The
 * span is passed to `fn` so callers can add attributes (e.g. the SUT status code).
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => T | Promise<T>,
  opts: { attributes?: Attributes } = {},
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: opts.attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
