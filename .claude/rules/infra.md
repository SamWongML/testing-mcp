---
paths:
  - "infra/**/*.ts"
  - "Dockerfile"
  - "docker-entrypoint.sh"
---

# `@atp/infra` — AWS CDK stacks + the container image

Four stacks in `infra/src/`, composed by `infra/bin/app.ts`: `network` (VPC, NAT, gateway
endpoints, the shared security groups) → `data` (RDS Multi-AZ, DynamoDB `tasks`+`idempotency`,
S3 artifacts) → `ecs` (ALB'd server + worker services, autoscaling, IAM) and `observability`
(dashboard + alarms). Runbook: [docs/deploy.md](../../docs/deploy.md).

## Testing — the seam is the synthesized template

Tests assert against `Template.fromStack(...)` — the CloudFormation that actually deploys —
not against construct objects. They encode the deployment *properties* (Multi-AZ,
gateway endpoints, health-check path, least-privilege roles, TTL attributes), never CDK's own
behaviour. They run in the normal `pnpm test` (no AWS, no credentials, no Docker).

`pnpm synth` runs `cdk synth` for every stack and is a CI step. It must stay **Docker-free**:
the ecs stack references a *pushed image URI* (`imageUri`), never `ContainerImage.fromAsset`.
Reintroducing an asset would make every PR need a Docker daemon.

## The cycle trap

`data` and `ecs` both build on `network`, and `ecs` reads `data`'s table/bucket names. So any
construct that makes `data` or `network` reference something **defined in `ecs`** is a
dependency cycle CDK rejects at synth. That is why `NetworkStack` owns *both* the app and ALB
security groups, and why the ALB **instance** is constructed here and handed to the
`ApplicationLoadBalancedFargateService` pattern via its `loadBalancer` prop — the pattern is
still used, it just no longer creates the security group that caused the cycle. Grant ingress
**downward** (data ← network's SG), never upward.

## Names that must match the application

- DynamoDB keys/attributes (`run_id`, `idem_key`, `ttl`) mirror `packages/store/src/aws/attributes.ts`.
- Metric names live in `infra/src/metrics.ts` and mirror `mcp-server/src/telemetry.ts`. A
  rename on one side silently breaks worker autoscaling — change both.
- **Dimension keys too, and this one has already bitten.** `runs_total` is emitted with the
  attribute key `RUN_STATE_ATTRIBUTE` (`telemetry.ts`) and queried with `RUN_STATE_DIMENSION`
  (`metrics.ts`). CloudWatch matches dimensions as an **exact set**: a mismatch does not error,
  it returns no datapoints, so the alarm sits in `INSUFFICIENT_DATA` forever and reads as
  healthy. A past change shipped `status` vs `state` and silently disabled two alarms. Tests on both sides pin the
  literal — keep them.
- **Metrics only reach CloudWatch through a collector you must run yourself.** The app exports
  OTLP; nothing in `infra/` provisions an ADOT collector. Until one translates OTLP →
  `PutMetricData` in namespace `ATP`, the dashboard is blank and `queue_depth` autoscaling
  never fires.
- `CONTAINER_PORT` is re-exported from `network-stack.ts` so the SG rule and the target group
  cannot drift apart.

## The image

One image, three roles — `docker-entrypoint.sh` dispatches on `MODE` (`server`/`worker`/
`migrate`). It runs TypeScript through `tsx` rather than a `tsc` bundle, matching the
repo-wide no-build design (`@atp/*` resolve to `src/index.ts`); a consequence worth keeping is
that `packages/store/src/db/migrations/*.sql` is simply present at runtime. `tini` is PID 1 so
ECS's SIGTERM reaches the app's graceful-shutdown handlers. `exec` in the entrypoint is
load-bearing — without it the signal stops at the shell.

Migrations run as a **one-off `MODE=migrate` task before** a rollout, never at service boot
(concurrent DDL across a rolling deploy's tasks wedges the deploy).

`cdk.out/` is generated — gitignored and eslint-ignored.
