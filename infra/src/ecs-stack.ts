import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsp from "aws-cdk-lib/aws-ecs-patterns";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

import { METRIC_NAMESPACE, QUEUE_DEPTH_METRIC } from "./metrics";
import { DEFAULT_CONTAINER_PORT } from "./network-stack";

/**
 * The compute tier (research §17.1/§17.3): one **stateless** ALB'd `mcp-server` service that
 * scales on requests-per-target, and one **worker** service that scales on the `queue_depth`
 * metric the P10 telemetry publishes. Splitting them is what keeps a 20-minute suite from
 * occupying a request-path task (§11.3 mode 1).
 *
 * Everything the containers need to pick their storage adapters is injected as environment
 * (`TASK_STORE`/`ARTIFACT_STORE` + table/bucket names) so the same image runs against the
 * stage-1 Postgres collapse or the DynamoDB stage without a rebuild.
 */

export interface EcsStackProps extends StackProps {
  envName: string;
  vpc: ec2.IVpc;
  /** Shared task security group from the network stack (already allowed into Postgres). */
  appSecurityGroup: ec2.ISecurityGroup;
  /** The ALB's security group, also from the network stack — see `NetworkStack` for why
   *  both live there rather than here. */
  albSecurityGroup: ec2.ISecurityGroup;
  database: rds.DatabaseInstance;
  tasksTable: dynamodb.Table;
  idempotencyTable: dynamodb.Table;
  artifactBucket: s3.Bucket;
  /** Fully-qualified image URI to deploy (e.g. `<acct>.dkr.ecr.<region>.amazonaws.com/atp:v3`),
   *  built from the repo `Dockerfile` and pushed by the pipeline. Referencing a pushed image
   *  rather than a CDK Docker *asset* is deliberate: it keeps `cdk synth` free of a Docker
   *  daemon, which is what lets CI synthesize the stacks on every PR. */
  imageUri: string;
  /** Container image override (tests inject one; the deploy path uses `imageUri`). */
  image?: ecs.ContainerImage;
  serverDesiredCount?: number;
  workerDesiredCount?: number;
  /** Enable the §11.3 mode-2 escape hatch: the server may launch one-off Fargate run tasks. */
  enableRunTask?: boolean;
  /** OAuth 2.1 gate (ADR-007). Off ⇒ the internal-deployment path (ALB-level protection). */
  auth?: { issuer: string; resource: string; jwksUri: string };
  /** OTLP collector endpoint for traces/metrics (P10 `initTelemetry` exporter selection). */
  otlpEndpoint?: string;
  /** ACM certificate for the ALB. **Strongly recommended**: without it the listener is plain
   *  HTTP, so OAuth bearer tokens (ADR-007) would cross the network in cleartext. Only omit
   *  for a private, non-authenticated deployment behind another TLS boundary. */
  certificateArn?: string;
}

const CONTAINER_PORT = DEFAULT_CONTAINER_PORT;

export class EcsStack extends Stack {
  readonly cluster: ecs.Cluster;
  readonly serverService: ecs.FargateService;
  readonly workerService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc: props.vpc,
      clusterName: `atp-${props.envName}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const image = props.image ?? ecs.ContainerImage.fromRegistry(props.imageUri);

    // The load balancer is built explicitly so it can use the network stack's security
    // group; letting the pattern create one would put the SG here and make the ingress rule
    // on `appSecurityGroup` a cross-stack edge back into network — a dependency cycle.
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "Lb", {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
    });

    /** Config every container shares; `MODE` is what makes one a server and one a worker. */
    const baseEnvironment = (mode: "server" | "worker"): Record<string, string> => ({
      MODE: mode,
      NODE_ENV: "production",
      SERVICE_NAME: `atp-${mode}`,
      PORT: String(CONTAINER_PORT),
      MANIFEST_PATH: "/app/dist/manifest.json",
      // Store selection — the P11 exit criterion: Postgres↔DynamoDB is config, not code.
      TASK_STORE: "dynamodb",
      DYNAMO_TASKS_TABLE: props.tasksTable.tableName,
      DYNAMO_IDEMPOTENCY_TABLE: props.idempotencyTable.tableName,
      ARTIFACT_STORE: "s3",
      S3_BUCKET: props.artifactBucket.bucketName,
      OTEL_ENABLED: String(Boolean(props.otlpEndpoint)),
      ...(props.otlpEndpoint
        ? { OTEL_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_ENDPOINT: props.otlpEndpoint }
        : {}),
      ...(props.auth
        ? {
            AUTH_ENABLED: "true",
            AUTH_ISSUER: props.auth.issuer,
            AUTH_RESOURCE: props.auth.resource,
            AUTH_JWKS_URI: props.auth.jwksUri,
          }
        : {}),
    });

    // The RDS-managed secret is a JSON blob (username/password/host/port/dbname), not a
    // connection string — it is injected whole and `resolveDatabaseUrl` assembles the URL in
    // the app, so no plaintext credential is ever part of the task definition.
    const dbSecret = props.database.secret!;
    const secrets = { DATABASE_SECRET: ecs.Secret.fromSecretsManager(dbSecret) };

    const logging = (mode: string): ecs.LogDriver =>
      ecs.LogDrivers.awsLogs({
        streamPrefix: `atp-${mode}`,
        logRetention: logs.RetentionDays.ONE_MONTH,
      });

    // ---- server: stateless, ALB'd, scales on RPS ----------------------------------------
    const server = new ecsp.ApplicationLoadBalancedFargateService(this, "McpServer", {
      cluster: this.cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: props.serverDesiredCount ?? 2,
      loadBalancer,
      ...(props.certificateArn
        ? {
            certificate: acm.Certificate.fromCertificateArn(this, "Cert", props.certificateArn),
            protocol: elbv2.ApplicationProtocol.HTTPS,
            // Anything arriving on :80 is bounced to :443 rather than served in the clear.
            redirectHTTP: true,
          }
        : {}),
      // Never drop below the desired count mid-deploy: the surface must stay servable.
      minHealthyPercent: 100,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.appSecurityGroup],
      circuitBreaker: { rollback: true },
      taskImageOptions: {
        image,
        containerPort: CONTAINER_PORT,
        environment: baseEnvironment("server"),
        secrets,
        logDriver: logging("server"),
      },
    });
    this.serverService = server.service;

    server.targetGroup.configureHealthCheck({
      path: "/healthz",
      interval: Duration.seconds(15),
      healthyThresholdCount: 2,
    });
    // No session state to preserve, so draining only needs to outlast an in-flight request.
    server.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");

    server.service
      .autoScaleTaskCount({ minCapacity: props.serverDesiredCount ?? 2, maxCapacity: 20 })
      .scaleOnRequestCount("Rps", {
        requestsPerTarget: 200,
        targetGroup: server.targetGroup,
        scaleInCooldown: Duration.minutes(2),
        scaleOutCooldown: Duration.seconds(30),
      });

    // ---- worker: no ALB, scales on queue depth -------------------------------------------
    const workerTaskDef = new ecs.FargateTaskDefinition(this, "WorkerTaskDef", {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });
    workerTaskDef.addContainer("worker", {
      image,
      environment: baseEnvironment("worker"),
      secrets,
      logging: logging("worker"),
      // tini in the image reaps and forwards signals; give a draining run time to finish.
      stopTimeout: Duration.seconds(120),
    });

    this.workerService = new ecs.FargateService(this, "Worker", {
      cluster: this.cluster,
      taskDefinition: workerTaskDef,
      desiredCount: props.workerDesiredCount ?? 2,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.appSecurityGroup],
      circuitBreaker: { rollback: true },
      // A rolling deploy must not kill in-flight runs; the lease reaper is the backstop.
      minHealthyPercent: 100,
    });

    const queueDepth = new cloudwatch.Metric({
      namespace: METRIC_NAMESPACE,
      metricName: QUEUE_DEPTH_METRIC,
      statistic: "Maximum",
      period: Duration.minutes(1),
    });

    // Step scaling, not target tracking: queue depth is bursty and a backlog of 100 wants a
    // bigger jump than a backlog of 20 (§17.3).
    this.workerService
      .autoScaleTaskCount({ minCapacity: props.workerDesiredCount ?? 2, maxCapacity: 50 })
      .scaleOnMetric("QueueDepth", {
        metric: queueDepth,
        scalingSteps: [
          { upper: 0, change: -1 },
          { lower: 20, change: +2 },
          { lower: 100, change: +5 },
        ],
        cooldown: Duration.minutes(1),
      });

    if (props.enableRunTask) {
      // The server needs to know *what* to launch; the IAM grant below says it *may*.
      const serverContainer = server.taskDefinition.defaultContainer!;
      serverContainer.addEnvironment("RUN_TASK_ENABLED", "true");
      serverContainer.addEnvironment("RUN_TASK_CLUSTER", this.cluster.clusterName);
      serverContainer.addEnvironment("RUN_TASK_DEFINITION", workerTaskDef.family);
      serverContainer.addEnvironment("RUN_TASK_CONTAINER", "worker");
      serverContainer.addEnvironment(
        "RUN_TASK_SUBNETS",
        props.vpc
          .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
          .subnetIds.join(","),
      );
      serverContainer.addEnvironment(
        "RUN_TASK_SECURITY_GROUPS",
        props.appSecurityGroup.securityGroupId,
      );
    }

    // ---- least-privilege task roles (§17.2) ----------------------------------------------
    const serverRole = server.taskDefinition.taskRole;
    const workerRole = workerTaskDef.taskRole;

    // Both sides read and write hot task state (the server creates + cancels, the worker
    // progresses + finalizes), and both read the idempotency table.
    for (const role of [serverRole, workerRole]) {
      props.tasksTable.grantReadWriteData(role);
      props.idempotencyTable.grantReadWriteData(role);
    }

    // Artifacts: the worker produces them, the server only reads (to render and presign).
    props.artifactBucket.grantPut(workerRole);
    props.artifactBucket.grantRead(workerRole);
    props.artifactBucket.grantRead(serverRole);

    if (props.enableRunTask) {
      // §11.3 mode 2: the server may launch a one-off Fargate task for a very long run.
      // The app launches by *family* (`RUN_TASK_DEFINITION` below), so the grant must cover
      // every revision of that family — a grant pinned to one revision breaks the next deploy.
      serverRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ["ecs:RunTask"],
          resources: [
            Stack.of(this).formatArn({
              service: "ecs",
              resource: "task-definition",
              resourceName: `${workerTaskDef.family}:*`,
            }),
          ],
          conditions: { ArnEquals: { "ecs:cluster": this.cluster.clusterArn } },
        }),
      );
      // RunTask needs to hand the launched task its execution + task roles.
      serverRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [workerTaskDef.taskRole.roleArn, workerTaskDef.executionRole!.roleArn],
          // Without this the server could hand these roles to any service that accepts a
          // PassRole, not just ECS.
          conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
        }),
      );
    }
  }
}
