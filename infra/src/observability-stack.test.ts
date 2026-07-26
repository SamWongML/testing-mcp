import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import { ObservabilityStack } from "./observability-stack";

function synth(alarmEmail?: string): Template {
  return Template.fromStack(
    new ObservabilityStack(new App(), "TestObs", { envName: "test", alarmEmail }),
  );
}

describe("ObservabilityStack", () => {
  let template: Template;
  beforeAll(() => {
    template = synth();
  });

  it("alarms on the four operational signals from the plan", () => {
    const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm"));
    const metrics = alarms.map((a) => a.Properties?.MetricName ?? "composite");

    //: "alarms: queue depth, pass rate, p95 duration, worker errors".
    expect(metrics).toContain("queue_depth");
    expect(metrics).toContain("run_duration_ms");
    expect(metrics).toContain("runs_total");
    expect(alarms.length).toBeGreaterThanOrEqual(4);
  });

  it("alarms on p95 duration, not the average", () => {
    const p95 = Object.values(template.findResources("AWS::CloudWatch::Alarm")).find(
      (a) => a.Properties?.MetricName === "run_duration_ms",
    );
    // An average hides the slow tail that actually breaks a client's polling budget.
    expect(p95?.Properties?.ExtendedStatistic).toBe("p95");
  });

  it("publishes a dashboard for the same signals", () => {
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    const dashboard = Object.values(template.findResources("AWS::CloudWatch::Dashboard"))[0];
    const body = JSON.stringify(dashboard?.Properties?.DashboardBody ?? "");
    for (const metric of ["queue_depth", "runs_total", "run_duration_ms"]) {
      expect(body).toContain(metric);
    }
  });

  it("notifies an SNS topic only when an alarm email is configured", () => {
    template.resourceCountIs("AWS::SNS::Topic", 0);

    const withEmail = synth("oncall@example.com");
    withEmail.resourceCountIs("AWS::SNS::Topic", 1);
    withEmail.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "oncall@example.com",
    });
    // Every alarm routes to the topic, or it is decoration rather than paging.
    const alarms = Object.values(withEmail.findResources("AWS::CloudWatch::Alarm"));
    expect(alarms.every((a) => (a.Properties?.AlarmActions ?? []).length > 0)).toBe(true);
  });

  it("queries runs_total on the dimension key the app actually publishes", () => {
    // CloudWatch matches dimensions as an exact set: querying `state` when the app emits
    // `status` yields no datapoints at all. The alarm does not error — it sits in
    // INSUFFICIENT_DATA forever, so a collapsing pass rate pages nobody. The matching
    // assertion on the emitting side lives in `packages/mcp-server/src/telemetry.test.ts`.
    const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm"));
    const dimensionKeys = new Set(
      alarms.flatMap((a) => {
        const direct = (a.Properties?.Dimensions ?? []) as { Name: string }[];
        const viaMath = (
          (a.Properties?.Metrics ?? []) as {
            MetricStat?: { Metric?: { Dimensions?: { Name: string }[] } };
          }[]
        ).flatMap((m) => m.MetricStat?.Metric?.Dimensions ?? []);
        return [...direct, ...viaMath].map((d) => d.Name);
      }),
    );
    expect(dimensionKeys).toContain("status");
    expect(dimensionKeys).not.toContain("state");
  });
});
