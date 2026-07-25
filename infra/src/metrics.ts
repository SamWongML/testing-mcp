/**
 * The CloudWatch identity of the metrics the application publishes (P10 `telemetry.ts`).
 * Autoscaling and dashboards both key off these, and a rename on either side silently
 * breaks scaling — so the names live in one place the CDK stacks share.
 */

/** OTel `service.namespace` → CloudWatch namespace for the exported metrics. */
export const METRIC_NAMESPACE = "ATP";

/** Ready-to-claim jobs; the worker autoscaling signal (§11.3, §15). */
export const QUEUE_DEPTH_METRIC = "queue_depth";
/** Terminal runs, dimensioned by state. */
export const RUNS_TOTAL_METRIC = "runs_total";
/** Wall-clock run duration, for the p95 latency alarm. */
export const RUN_DURATION_METRIC = "run_duration_ms";
/** Failed assertions, dimensioned by test. */
export const ASSERTION_FAILURES_METRIC = "assertion_failures_total";
