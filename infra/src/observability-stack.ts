import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

import {
  ASSERTION_FAILURES_METRIC,
  METRIC_NAMESPACE,
  QUEUE_DEPTH_METRIC,
  RUN_DURATION_METRIC,
  RUNS_TOTAL_METRIC,
} from "./metrics";

/**
 * Dashboards + alarms over the metrics P10's `RunMetrics` publishes (research §15). The
 * signals are the ones that tell you the *platform* is unhealthy, as distinct from a test
 * legitimately failing: a queue that isn't draining, runs getting slower, workers erroring,
 * and a pass rate that falls off a cliff (which usually means the SUT or auth broke, not
 * that every test regressed at once).
 */

export interface ObservabilityStackProps extends StackProps {
  envName: string;
  /** Subscribe an address to every alarm. Without it the alarms exist but page nobody. */
  alarmEmail?: string;
  /** Backlog that must persist before the queue-depth alarm fires. */
  queueDepthThreshold?: number;
  /** p95 run duration (ms) considered unhealthy. */
  runDurationP95Ms?: number;
}

export class ObservabilityStack extends Stack {
  readonly dashboard: cloudwatch.Dashboard;
  readonly alarmTopic?: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    if (props.alarmEmail) {
      this.alarmTopic = new sns.Topic(this, "Alarms", {
        displayName: `atp-${props.envName} alarms`,
      });
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }

    const metric = (
      metricName: string,
      opts: { statistic?: string; dimensions?: Record<string, string> } = {},
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName,
        statistic: opts.statistic ?? "Sum",
        period: Duration.minutes(5),
        ...(opts.dimensions ? { dimensionsMap: opts.dimensions } : {}),
      });

    const queueDepth = metric(QUEUE_DEPTH_METRIC, { statistic: "Maximum" });
    const runDuration = new cloudwatch.Metric({
      namespace: METRIC_NAMESPACE,
      metricName: RUN_DURATION_METRIC,
      statistic: "p95",
      period: Duration.minutes(5),
    });
    const runsCompleted = metric(RUNS_TOTAL_METRIC, { dimensions: { state: "completed" } });
    const runsFailed = metric(RUNS_TOTAL_METRIC, { dimensions: { state: "failed" } });
    const assertionFailures = metric(ASSERTION_FAILURES_METRIC);

    const alarm = (
      id: string,
      alarmMetric: cloudwatch.IMetric,
      config: {
        threshold: number;
        evaluationPeriods: number;
        comparisonOperator?: cloudwatch.ComparisonOperator;
        alarmDescription: string;
      },
    ): cloudwatch.Alarm => {
      const created = new cloudwatch.Alarm(this, id, {
        metric: alarmMetric,
        threshold: config.threshold,
        evaluationPeriods: config.evaluationPeriods,
        comparisonOperator:
          config.comparisonOperator ?? cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: config.alarmDescription,
        // Missing data means nothing ran, which is not by itself a fault.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      if (this.alarmTopic) created.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      return created;
    };

    // 1. Queue depth: workers are not keeping up (or are not running at all).
    alarm("QueueDepthHigh", queueDepth, {
      threshold: props.queueDepthThreshold ?? 100,
      evaluationPeriods: 3,
      alarmDescription: "Run backlog is not draining — check worker service health/scaling",
    });

    // 2. p95 duration: the slow tail, which is what breaks a client's polling budget.
    alarm("RunDurationP95High", runDuration, {
      threshold: props.runDurationP95Ms ?? 300_000,
      evaluationPeriods: 3,
      alarmDescription: "p95 run duration regressed — SUT latency or a stuck polling step",
    });

    // 3. Pass rate: completed / (completed + failed), so a spike of failures pages even when
    //    total volume is low. A platform fault usually shows up here first.
    const passRate = new cloudwatch.MathExpression({
      expression: "100 * completed / (completed + failed)",
      usingMetrics: { completed: runsCompleted, failed: runsFailed },
      period: Duration.minutes(15),
      label: "pass rate %",
    });
    alarm("PassRateLow", passRate, {
      threshold: 80,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      alarmDescription: "Pass rate below 80% — suspect auth, environment, or SUT outage",
    });

    // 4. Worker errors: runs terminating as failed at all.
    alarm("WorkerErrors", runsFailed, {
      threshold: 5,
      evaluationPeriods: 2,
      alarmDescription: "Failed runs are accumulating — check worker logs",
    });

    this.dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `atp-${props.envName}`,
    });
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: "Queue depth", left: [queueDepth], width: 12 }),
      new cloudwatch.GraphWidget({ title: "Run duration p95", left: [runDuration], width: 12 }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Runs by outcome",
        left: [runsCompleted, runsFailed],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Assertion failures",
        left: [assertionFailures],
        width: 12,
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({ title: "Pass rate", metrics: [passRate], width: 24 }),
    );
  }
}
