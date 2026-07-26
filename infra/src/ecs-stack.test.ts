import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import { DataStack } from "./data-stack";
import { EcsStack } from "./ecs-stack";
import { NetworkStack } from "./network-stack";

function synth(props: { enableRunTask?: boolean; certificateArn?: string } = {}): Template {
  const app = new App();
  const network = new NetworkStack(app, "TestNetwork", { envName: "test" });
  const data = new DataStack(app, "TestData", {
    envName: "test",
    vpc: network.vpc,
    appSecurityGroup: network.appSecurityGroup,
  });
  return Template.fromStack(
    new EcsStack(app, "TestEcs", {
      envName: "test",
      vpc: network.vpc,
      appSecurityGroup: network.appSecurityGroup,
      albSecurityGroup: network.albSecurityGroup,
      database: data.database,
      tasksTable: data.tasksTable,
      idempotencyTable: data.idempotencyTable,
      artifactBucket: data.artifactBucket,
      imageUri: "atp:test",
      ...props,
    }),
  );
}

/** Find the one task definition whose container runs in `mode`. */
function taskDefFor(template: Template, mode: string): Record<string, unknown> {
  const defs = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
  const match = defs.find((d) => {
    const containers = d.Properties?.ContainerDefinitions as
      { Environment?: { Name: string; Value: string }[] }[] | undefined;
    return containers?.[0]?.Environment?.some((e) => e.Name === "MODE" && e.Value === mode);
  });
  if (!match) throw new Error(`no task definition with MODE=${mode}`);
  return match;
}

describe("EcsStack", () => {
  let template: Template;
  beforeAll(() => {
    template = synth();
  });

  it("runs the stateless server and the worker as two separate services", () => {
    //: separate worker service "so long runs never block the request path".
    template.resourceCountIs("AWS::ECS::Service", 2);
    expect(taskDefFor(template, "server")).toBeDefined();
    expect(taskDefFor(template, "worker")).toBeDefined();
    // Only the server is fronted by a load balancer.
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
  });

  it("health-checks the server on /healthz and drains connections on deploy", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/healthz",
      // Rolling deploys are safe only because the service is stateless.
      TargetGroupAttributes: Match.arrayWith([
        Match.objectLike({ Key: "deregistration_delay.timeout_seconds" }),
      ]),
    });
  });

  it("scales the server on requests-per-target and the worker on queue_depth", () => {
    const policies = template.findResources("AWS::ApplicationAutoScaling::ScalingPolicy");

    const rps = Object.values(policies).find(
      (p) =>
        p.Properties?.TargetTrackingScalingPolicyConfiguration?.PredefinedMetricSpecification
          ?.PredefinedMetricType === "ALBRequestCountPerTarget",
    );
    expect(rps).toBeDefined();

    // Step scaling puts the metric on the *alarm*, not the policy — so the check that the
    // `queue_depth` signal really drives the workers is: an alarm on that metric whose
    // action is one of this stack's step-scaling policies.
    const stepPolicyIds = Object.entries(policies)
      .filter(([, p]) => p.Properties?.PolicyType === "StepScaling")
      .map(([id]) => id);
    expect(stepPolicyIds.length).toBeGreaterThan(0);

    const queueAlarms = Object.values(template.findResources("AWS::CloudWatch::Alarm")).filter(
      (a) => a.Properties?.MetricName === "queue_depth" && a.Properties?.Namespace === "ATP",
    );
    expect(queueAlarms.length).toBeGreaterThan(0);
    const actionRefs = JSON.stringify(queueAlarms.map((a) => a.Properties?.AlarmActions));
    expect(stepPolicyIds.some((id) => actionRefs.includes(id))).toBe(true);
  });

  it("injects the store selection as config, not code", () => {
    const server = taskDefFor(template, "server");
    const containers = server.Properties as {
      ContainerDefinitions: {
        Environment: { Name: string; Value: unknown }[];
        Secrets: { Name: string }[];
      }[];
    };
    const env = new Map(
      containers.ContainerDefinitions[0]!.Environment.map((e) => [e.Name, e.Value]),
    );

    expect(env.get("TASK_STORE")).toBe("dynamodb");
    expect(env.get("ARTIFACT_STORE")).toBe("s3");
    expect(env.has("DYNAMO_TASKS_TABLE")).toBe(true);
    expect(env.has("DYNAMO_IDEMPOTENCY_TABLE")).toBe(true);
    expect(env.has("S3_BUCKET")).toBe(true);

    // The database credential arrives from Secrets Manager, never as a plaintext value.
    const secretNames = containers.ContainerDefinitions[0]!.Secrets.map((s) => s.Name);
    expect(secretNames).toContain("DATABASE_SECRET");
    expect(env.has("DATABASE_URL")).toBe(false);
  });

  it("grants least-privilege task roles: the worker writes artifacts, the server only reads", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const actionsOf = (id: string): string[] => {
      const statements = (policies[id]?.Properties?.PolicyDocument?.Statement ?? []) as {
        Action: string | string[];
      }[];
      return statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    };
    const taskRolePolicy = (prefix: string): string => {
      const id = Object.keys(policies).find(
        (k) => k.startsWith(prefix) && k.includes("TaskRoleDefaultPolicy"),
      );
      if (!id) throw new Error(`no task-role policy for ${prefix}`);
      return id;
    };

    const serverActions = actionsOf(taskRolePolicy("McpServer"));
    const workerActions = actionsOf(taskRolePolicy("Worker"));

    // The worker produces artifacts; the server only reads them back to render and presign.
    expect(workerActions).toContain("s3:PutObject");
    expect(serverActions.some((a) => a.startsWith("s3:Put"))).toBe(false);
    expect(serverActions.some((a) => a.startsWith("s3:GetObject"))).toBe(true);

    // Both sides drive hot task state (server creates/cancels, worker progresses/finalizes).
    for (const actions of [serverActions, workerActions]) {
      expect(actions).toContain("dynamodb:PutItem");
      expect(actions).toContain("dynamodb:GetItem");
    }
  });

  it("omits ecs:RunTask unless the escape hatch is enabled (mode 2)", () => {
    const hasRunTask = (t: Template): boolean =>
      Object.values(t.findResources("AWS::IAM::Policy")).some((p) =>
        JSON.stringify(p.Properties ?? {}).includes("ecs:RunTask"),
      );
    expect(hasRunTask(template)).toBe(false);
    expect(hasRunTask(synth({ enableRunTask: true }))).toBe(true);
  });

  it("terminates TLS at the ALB and redirects plain HTTP when a certificate is supplied", () => {
    const withTls = synth({
      certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
    });
    const listeners = Object.values(withTls.findResources("AWS::ElasticLoadBalancingV2::Listener"));
    const protocols = listeners.map((l) => l.Properties?.Protocol);
    expect(protocols).toContain("HTTPS");

    // Without the redirect, an agent that forgets the scheme sends its OAuth bearer token
    // over cleartext and the ALB happily serves it.
    const http = listeners.find((l) => l.Properties?.Protocol === "HTTP");
    expect(http?.Properties?.DefaultActions?.[0]?.Type).toBe("redirect");
    expect(http?.Properties?.DefaultActions?.[0]?.RedirectConfig?.Protocol).toBe("HTTPS");
  });
});
