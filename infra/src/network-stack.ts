import { Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";

/**
 * VPC + networking (research §17.1/§17.2). ECS tasks run in **private** subnets and reach
 * the systems under test through NAT; DynamoDB and S3 are reached through **gateway**
 * endpoints instead, which keeps that traffic private and off the NAT's per-GB bill.
 */

export interface NetworkStackProps extends StackProps {
  /** Deployment environment name (`dev`/`staging`/`prod`) — used in resource naming. */
  envName: string;
  /** How many AZs to span. Two is the minimum for Multi-AZ RDS. */
  maxAzs?: number;
  /** Port the mcp-server container listens on (must match the ecs stack). */
  containerPort?: number;
}

/** Kept in sync with `ecs-stack.ts`'s `CONTAINER_PORT`. */
export const DEFAULT_CONTAINER_PORT = 3000;

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  /**
   * The security group every ECS task runs in. It lives here, not in the `ecs` stack, so the
   * `data` stack can allow Postgres ingress *from* it without depending on the `ecs` stack —
   * which would otherwise be a dependency cycle (ecs already reads the data stack's table
   * and bucket names).
   */
  readonly appSecurityGroup: ec2.SecurityGroup;
  /** The internet-facing ALB's security group. Owned here for the same reason: the ingress
   *  rule it needs on {@link appSecurityGroup} is then a purely intra-stack edge. */
  readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const containerPort = props.containerPort ?? DEFAULT_CONTAINER_PORT;

    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `atp-${props.envName}`,
      maxAzs: props.maxAzs ?? 2,
      // One NAT per AZ: an AZ outage must not take the other AZ's egress with it.
      natGateways: props.maxAzs ?? 2,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    this.vpc.addGatewayEndpoint("DynamoEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.appSecurityGroup = new ec2.SecurityGroup(this, "AppSecurityGroup", {
      vpc: this.vpc,
      description: "ECS tasks (mcp-server + worker)",
      // Egress to the systems under test is the whole point of the platform.
      allowAllOutbound: true,
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: this.vpc,
      description: "Public ALB fronting the MCP server",
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "HTTPS from agents",
    );
    this.appSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(containerPort),
      "ALB to mcp-server",
    );
  }
}
