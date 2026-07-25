import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { resolveExporters } from "./exporters";

/**
 * The exporter *selection* is the seam: which destination telemetry goes to is a deployment
 * decision (console in dev, OTLP → the CloudWatch/X-Ray collector in production, P11's
 * observability stack) and everything downstream — `withSpan`, `RunMetrics` — is unchanged.
 */
describe("resolveExporters", () => {
  it("defaults to the console exporter for local dev", () => {
    const { spanExporter } = resolveExporters({ OTEL_EXPORTER: "console" });
    expect(spanExporter).toBeInstanceOf(ConsoleSpanExporter);
  });

  it("selects OTLP over HTTP when an endpoint is configured", () => {
    const { spanExporter, metricReader } = resolveExporters({
      OTEL_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });
    expect(spanExporter).toBeInstanceOf(OTLPTraceExporter);
    // The reader wraps the metric exporter; assert the exporter it will push through.
    expect(metricReader).toBeDefined();
    expect(
      (metricReader as unknown as { _exporter?: unknown })._exporter ??
        (metricReader as unknown as { _metricExporter?: unknown })._metricExporter,
    ).toBeInstanceOf(OTLPMetricExporter);
  });

  it("fails fast when OTLP is selected with no endpoint", () => {
    // Silently exporting nowhere is worse than not starting: the alarms would never fire.
    expect(() => resolveExporters({ OTEL_EXPORTER: "otlp" })).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
  });
});
