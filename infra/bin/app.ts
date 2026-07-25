import { App, Tags } from "aws-cdk-lib";

import { DataStack } from "../src/data-stack";
import { EcsStack } from "../src/ecs-stack";
import { NetworkStack } from "../src/network-stack";
import { ObservabilityStack } from "../src/observability-stack";

/**
 * The CDK app (ADR-008). Everything environment-specific arrives as CDK **context**
 * (`-c key=value` or `cdk.context.json`), so the same code synthesizes dev/staging/prod and
 * `cdk synth` needs no AWS credentials — which is what lets CI synthesize on every PR.
 *
 *   cdk synth --all -c env=dev
 *   cdk deploy --all -c env=prod -c imageUri=<acct>.dkr.ecr.<region>.amazonaws.com/atp:v3
 */
const app = new App();

const envName = (app.node.tryGetContext("env") as string | undefined) ?? "dev";
const imageUri =
  (app.node.tryGetContext("imageUri") as string | undefined) ?? "public.ecr.aws/atp/atp:latest";
const alarmEmail = app.node.tryGetContext("alarmEmail") as string | undefined;
const otlpEndpoint = app.node.tryGetContext("otlpEndpoint") as string | undefined;
const enableRunTask = app.node.tryGetContext("enableRunTask") === "true";
const certificateArn = app.node.tryGetContext("certificateArn") as string | undefined;

// Unset in CI so `cdk synth` stays region/account agnostic; set at deploy time.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const authIssuer = app.node.tryGetContext("authIssuer") as string | undefined;
const authResource = app.node.tryGetContext("authResource") as string | undefined;
const authJwksUri = app.node.tryGetContext("authJwksUri") as string | undefined;
const auth =
  authIssuer && authResource && authJwksUri
    ? { issuer: authIssuer, resource: authResource, jwksUri: authJwksUri }
    : undefined;

const prefix = `Atp-${envName}`;

const network = new NetworkStack(app, `${prefix}-Network`, { env, envName });

const data = new DataStack(app, `${prefix}-Data`, {
  env,
  envName,
  vpc: network.vpc,
  appSecurityGroup: network.appSecurityGroup,
});

new EcsStack(app, `${prefix}-Ecs`, {
  env,
  envName,
  vpc: network.vpc,
  appSecurityGroup: network.appSecurityGroup,
  albSecurityGroup: network.albSecurityGroup,
  database: data.database,
  tasksTable: data.tasksTable,
  idempotencyTable: data.idempotencyTable,
  artifactBucket: data.artifactBucket,
  imageUri,
  enableRunTask,
  auth,
  otlpEndpoint,
  certificateArn,
});

new ObservabilityStack(app, `${prefix}-Observability`, { env, envName, alarmEmail });

Tags.of(app).add("app", "atp");
Tags.of(app).add("env", envName);
