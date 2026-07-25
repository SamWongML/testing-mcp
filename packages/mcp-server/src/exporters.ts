import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  ConsoleMetricExporter,
  type MetricReader,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * Telemetry destination selection (P11; research §15, ADR-008). `initTelemetry` takes the
 * exporters as arguments — this is the piece that turns configuration into them, so the
 * P11 `observability` CDK stack's collector endpoint is all that changes between dev and
 * production. Tests inject in-memory exporters and never go through here.
 */

export interface ExporterConfig {
  OTEL_EXPORTER?: "console" | "otlp";
  /** Base OTLP/HTTP endpoint of the collector (the ADOT sidecar / gateway), e.g.
   *  `http://localhost:4318`. Signal paths (`/v1/traces`, `/v1/metrics`) are appended. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** How often metrics are pushed to the collector. */
  OTEL_METRIC_EXPORT_INTERVAL_MS?: number;
}

export interface ResolvedExporters {
  spanExporter: SpanExporter;
  metricReader: MetricReader;
}

const DEFAULT_EXPORT_INTERVAL_MS = 60_000;

export function resolveExporters(config: ExporterConfig): ResolvedExporters {
  const exportIntervalMillis = config.OTEL_METRIC_EXPORT_INTERVAL_MS ?? DEFAULT_EXPORT_INTERVAL_MS;

  if (config.OTEL_EXPORTER === "otlp") {
    const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint) {
      // Exporting into the void would leave the dashboards and alarms permanently blank,
      // which reads as "healthy" — refuse to start instead.
      throw new Error("OTEL_EXPORTER=otlp requires OTEL_EXPORTER_OTLP_ENDPOINT");
    }
    const base = endpoint.replace(/\/$/, "");
    return {
      spanExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
        exportIntervalMillis,
      }),
    };
  }

  return {
    spanExporter: new ConsoleSpanExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new ConsoleMetricExporter(),
      exportIntervalMillis,
    }),
  };
}
