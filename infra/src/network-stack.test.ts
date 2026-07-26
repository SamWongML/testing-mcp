import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { NetworkStack } from "./network-stack";

/**
 * The synthesized CloudFormation template is the public interface of a stack — it is what
 * actually gets deployed — so that is the seam these tests assert against (`cdk synth` in
 * CI is the same operation). They encode the deployment properties, not CDK's own
 * behaviour.
 */
function synth(): Template {
  return Template.fromStack(new NetworkStack(new App(), "TestNetwork", { envName: "test" }));
}

describe("NetworkStack", () => {
  it("spans two AZs with public and private subnets", () => {
    const template = synth();
    template.resourceCountIs("AWS::EC2::VPC", 1);
    // Two AZs × (public + private-with-egress) — the Multi-AZ base RDS and ECS need.
    template.resourceCountIs("AWS::EC2::Subnet", 4);
    template.resourceCountIs("AWS::EC2::NatGateway", 2);
  });

  it("reaches DynamoDB and S3 through gateway endpoints, not the NAT", () => {
    const template = synth();
    //: "DynamoDB/S3 via Gateway VPC Endpoints (no NAT cost, private)".
    const endpoints = Object.values(template.findResources("AWS::EC2::VPCEndpoint"));
    expect(endpoints).toHaveLength(2);
    expect(endpoints.every((e) => e.Properties?.VpcEndpointType === "Gateway")).toBe(true);

    // The service name is a Fn::Join over the region, so match on the literal fragment.
    const services = endpoints.map((e) => JSON.stringify(e.Properties?.ServiceName));
    expect(services.some((s) => s.includes(".dynamodb"))).toBe(true);
    expect(services.some((s) => s.includes(".s3"))).toBe(true);
  });

  it("owns the shared app security group, so data can allow ingress without a cycle", () => {
    const stack = new NetworkStack(new App(), "TestNetwork", { envName: "test" });
    expect(stack.vpc).toBeDefined();
    // Placing it here (not in `ecs`) is what keeps data → network and ecs → network acyclic.
    expect(stack.appSecurityGroup).toBeDefined();
  });
});
