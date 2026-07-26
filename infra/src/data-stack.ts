import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/**
 * The three stores of, each used for its strength: **Postgres** (system of record +
 * `SKIP LOCKED` queue), **DynamoDB** (hot task state + idempotency, with TTL), **S3**
 * (artifacts, lifecycled). Attribute and key names mirror `@atp/store`'s adapters exactly —
 * `run_id`/`idem_key`/`ttl` — and the outputs here become the container config that
 * selects those adapters.
 */

export interface DataStackProps extends StackProps {
  envName: string;
  vpc: ec2.IVpc;
  /** The ECS task security group (owned by the network stack) allowed to reach Postgres. */
  appSecurityGroup: ec2.ISecurityGroup;
  /** How long artifacts are retained before expiry. */
  artifactRetentionDays?: number;
  /** Postgres instance size. Defaults are deliberately small; scale per environment. */
  instanceType?: ec2.InstanceType;
}

/** Keep prod data on a stack delete; let ephemeral environments clean up after themselves. */
const removalFor = (envName: string): RemovalPolicy =>
  envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

export class DataStack extends Stack {
  readonly database: rds.DatabaseInstance;
  readonly tasksTable: dynamodb.Table;
  readonly idempotencyTable: dynamodb.Table;
  readonly artifactBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const removalPolicy = removalFor(props.envName);

    this.database = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType:
        props.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      // Multi-AZ: the queue is the durability substrate for every in-flight run.
      multiAz: true,
      storageEncrypted: true,
      publiclyAccessible: false,
      databaseName: "atp",
      // Generated into Secrets Manager and injected at task start — never a literal.
      credentials: rds.Credentials.fromGeneratedSecret("atp"),
      backupRetention: Duration.days(props.envName === "prod" ? 14 : 1),
      deletionProtection: props.envName === "prod",
      removalPolicy,
    });

    // Ingress is granted here — the data stack depends on network, never on ecs.
    this.database.connections.allowDefaultPortFrom(
      props.appSecurityGroup,
      "ECS tasks (mcp-server + worker)",
    );

    const table = (id: string, partitionKey: string): dynamodb.Table =>
      new dynamodb.Table(this, id, {
        partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
        // Run volume is bursty (a nightly suite fan-out, then nothing) — on-demand rather
        // than provisioned capacity nobody tunes.
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        // DynamoDB's native TTL implements SEP-1686 "results retained for a server-defined
        // duration"; `DynamoTaskStore.deleteExpired` is the deterministic sweep alongside it.
        timeToLiveAttribute: "ttl",
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        removalPolicy,
      });

    this.tasksTable = table("TasksTable", "run_id");
    this.idempotencyTable = table("IdempotencyTable", "idem_key");

    this.artifactBucket = new s3.Bucket(this, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Artifacts are served through presigned URLs, never public reads.
      lifecycleRules: [
        {
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
          ],
          expiration: Duration.days(props.artifactRetentionDays ?? 365),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
      removalPolicy,
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
    });
  }
}
