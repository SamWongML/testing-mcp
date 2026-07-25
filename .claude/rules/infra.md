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
(dashboard + alarms). Runbook: [docs/deploy.md](../../docs/deploy.md). Research §17, ADR-008.

## Testing — the seam is the synthesized template

Tests assert against `Template.fromStack(...)` — the CloudFormation that actually deploys —
not against construct objects. They encode the §17.2 deployment *properties* (Multi-AZ,
gateway endpoints, health-check path, least-privilege roles, TTL attributes), never CDK's own
behaviour. They run in the normal `pnpm test` (no AWS, no credentials, no Docker).

`pnpm synth` runs `cdk synth` for every stack and is a CI step. It must stay **Docker-free**:
the ecs stack references a *pushed image URI* (`imageUri`), never `ContainerImage.fromAsset`.
Reintroducing an asset would make every PR need a Docker daemon.

## The cycle trap

`data` and `ecs` both build on `network`, and `ecs` reads `data`'s table/bucket names. So any
construct that makes `data` or `network` reference something **defined in `ecs`** is a
dependency cycle CDK rejects at synth. That is why `NetworkStack` owns *both* the app and ALB
security groups, and why the ALB is constructed explicitly rather than by the
`ApplicationLoadBalancedFargateService` pattern. Grant ingress **downward** (data ← network's
SG), never upward.

## Names that must match the application

- DynamoDB keys/attributes (`run_id`, `idem_key`, `ttl`) mirror `packages/store/src/aws/attributes.ts`.
- Metric names live in `infra/src/metrics.ts` and mirror `mcp-server/src/telemetry.ts`. A
  rename on one side silently breaks worker autoscaling — change both.
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

## Conventions

TypeScript strict + ESM, same as the rest of the repo (`verbatimModuleSyntax`,
`isolatedModules`, `noUncheckedIndexedAccess`). `cdk.out/` is generated — gitignored and
eslint-ignored.
