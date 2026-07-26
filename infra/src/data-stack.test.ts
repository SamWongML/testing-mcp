import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import { DataStack } from "./data-stack";
import { NetworkStack } from "./network-stack";

/** The data stack builds on the network stack's VPC, so both are synthesized together. */
function synth(): { stack: DataStack; template: Template } {
  const app = new App();
  const network = new NetworkStack(app, "TestNetwork", { envName: "test" });
  const stack = new DataStack(app, "TestData", {
    envName: "test",
    vpc: network.vpc,
    appSecurityGroup: network.appSecurityGroup,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe("DataStack", () => {
  let template: Template;
  beforeAll(() => {
    template = synth().template;
  });

  it("runs RDS PostgreSQL Multi-AZ with a Secrets Manager credential", () => {
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      MultiAZ: true,
      StorageEncrypted: true,
      PubliclyAccessible: false,
    });
    //: "Secrets via Secrets Manager injected at task start" — never a literal password.
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  });

  it("creates the tasks and idempotency tables keyed and TTL'd", () => {
    const tables = Object.values(template.findResources("AWS::DynamoDB::Table"));
    expect(tables).toHaveLength(2);

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "run_id", KeyType: "HASH" }],
      // The TTL attribute is what implements SEP-1686 result expiry.
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      BillingMode: "PAY_PER_REQUEST",
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "idem_key", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("stores artifacts in a private bucket that ages objects out", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: "Enabled",
            Transitions: [{ StorageClass: "STANDARD_IA", TransitionInDays: 30 }],
          }),
        ]),
      },
    });
  });

  it("exposes the table and bucket names the ecs stack injects as config", () => {
    const { stack } = synth();
    expect(stack.tasksTable.tableName).toBeDefined();
    expect(stack.idempotencyTable.tableName).toBeDefined();
    expect(stack.artifactBucket.bucketName).toBeDefined();
    expect(stack.database.secret).toBeDefined();
  });
});
