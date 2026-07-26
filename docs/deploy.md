# Deployment runbook

> Architecture: [docs/research.md](./research.md) · Infra code: [`infra/`](../infra) · Container: [`Dockerfile`](../Dockerfile)

How to get the platform onto AWS ECS and back off it again. Everything here is CDK; nothing is
clicked in the console.

## What gets deployed

Four stacks (`infra/bin/app.ts`), deployed in this order — each depends on the one above:

| Stack | Contains | Why |
|---|---|---|
| `Atp-<env>-Network` | VPC (2 AZs), public + private subnets, 2 NAT gateways, **gateway endpoints** for DynamoDB + S3, the shared app/ALB security groups | Tasks run private; DynamoDB/S3 traffic skips the NAT |
| `Atp-<env>-Data` | RDS PostgreSQL 16 **Multi-AZ**, DynamoDB `tasks` + `idempotency` tables (TTL on `ttl`), S3 artifact bucket (IA at 30d) | Storage split: record, hot state, blobs |
| `Atp-<env>-Ecs` | Fargate cluster, ALB'd `mcp-server` service (scales on RPS), `worker` service (scales on `queue_depth`), IAM task roles, Secrets Manager wiring | The request path and the run path scale separately |
| `Atp-<env>-Observability` | CloudWatch dashboard + alarms (queue depth, p95 duration, pass rate, worker errors) | Operational visibility |

The **same image** runs all roles; `MODE` picks one:

| `MODE` | Entrypoint | Role |
|---|---|---|
| `server` (default) | `packages/mcp-server/src/main.ts` | Stateless MCP HTTP surface |
| `worker` | `packages/mcp-server/src/main-worker.ts` | Claims jobs, runs the engine |
| `migrate` | `packages/mcp-server/src/main-migrate.ts` | Applies pending SQL, exits |

## Prerequisites

- AWS credentials for the target account, and an ECR repository for the image.
- Node 22 + `corepack enable` (pnpm 10.33 pinned).
- CDK bootstrapped, once per account/region:

```bash
pnpm --filter @atp/infra exec cdk bootstrap aws://<account>/<region>
```

## First deploy

**1 — Build and push the image.** The stacks reference a *pushed image URI*, not a CDK
Docker asset, so `cdk synth` never needs a Docker daemon (that is what lets CI synth on
every PR).

```bash
REPO=<account>.dkr.ecr.<region>.amazonaws.com/atp
TAG=$(git rev-parse --short HEAD)

aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin "$REPO"
docker build -t "$REPO:$TAG" .
docker push "$REPO:$TAG"
```

**2 — Deploy network + data.** RDS Multi-AZ takes ~15 minutes on first creation.

```bash
cd infra
pnpm exec cdk deploy Atp-prod-Network Atp-prod-Data -c env=prod -c imageUri="$REPO:$TAG"
```

**3 — Run migrations** before any service starts, as a one-off task. Migrations are
deliberately *not* run at service boot: a rolling deploy starts several tasks at once and
concurrent DDL is how a deploy gets wedged.

```bash
aws ecs run-task \
  --cluster atp-prod \
  --task-definition <worker-task-def> \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<private-subnets>],securityGroups=[<app-sg>],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"worker","environment":[{"name":"MODE","value":"migrate"}]}]}'
```

Confirm it exited `0` and logged `applied N migration(s)` (or `already current`).

**4 — Deploy compute + observability.**

```bash
pnpm exec cdk deploy Atp-prod-Ecs Atp-prod-Observability \
  -c env=prod -c imageUri="$REPO:$TAG" -c alarmEmail=oncall@example.com \
  -c certificateArn=arn:aws:acm:<region>:<account>:certificate/<id>
```

**5 — Verify.** Use `https://` only if you deployed with `certificateArn`; without it the ALB
listens on plain HTTP.

```bash
ALB=$(aws elbv2 describe-load-balancers --query 'LoadBalancers[?contains(LoadBalancerName,`Atp`)].DNSName' --output text)
SCHEME=https   # http:// if you deployed without certificateArn
curl -fsS "$SCHEME://$ALB/healthz"   # {"status":"ok"}
curl -fsS "$SCHEME://$ALB/readyz"    # {"status":"ready","tests":N}
```

Then drive one real run through the MCP surface (`list_tests` → `run_test`) and confirm a
trace object appears under `s3://<artifact-bucket>/mcp/<yyyy>/<mm>/<dd>/<runId>/`.

## Configuration

Set through CDK context (`-c key=value`) and surfaced to the containers as environment.

| Context key | Effect |
|---|---|
| `env` | Environment name; prefixes stack + resource names. `prod` also enables deletion protection and `RETAIN` removal policies. |
| `imageUri` | Image the services run. |
| `alarmEmail` | Creates an SNS topic and subscribes the address to every alarm. Without it the alarms exist but page nobody. |
| `certificateArn` | ACM certificate for the ALB. **Set this.** Without it the listener is plain **HTTP**, so OAuth bearer tokens cross the network in cleartext. With it, `:80` redirects to `:443`. |
| `otlpEndpoint` | Turns on `OTEL_ENABLED` + `OTEL_EXPORTER=otlp` pointed at your collector. |
| `authIssuer` / `authResource` / `authJwksUri` | All three ⇒ the OAuth 2.1 gate is enabled. Omit for the internal-deployment path where the ALB is the boundary. |
| `enableRunTask` | `true` grants the server `ecs:RunTask` and configures the mode-2 escape hatch (see below). |

Container-level knobs (see `packages/schema/src/config.ts` for the full, validated list):
`TASK_STORE` (`postgres`\|`dynamodb`), `ARTIFACT_STORE` (`local`\|`s3`), `DATABASE_SECRET`,
`AUTH_ENABLED`, `OTEL_ENABLED`, `RUN_TASK_ENABLED`.

### Secrets

The database credential is the RDS-managed Secrets Manager entry, injected **whole** as
`DATABASE_SECRET`; the app assembles the connection string from it
(`resolveDatabaseUrl`), so no plaintext URL ever appears in a task definition. If
`DATABASE_URL` is *also* set it wins — that precedence exists so local dev can point at a
throwaway database, and it means a stale `DATABASE_URL` in a task definition would silently
override the managed secret. To rotate:
rotate the secret in Secrets Manager, then force a new deployment of both services so the
tasks re-read it.

```bash
aws ecs update-service --cluster atp-prod --service <service> --force-new-deployment
```

### Scaling from stage 1 to stage 2

`TASK_STORE` is the switch. `postgres` collapses hot task state into the Postgres `tasks`
table (fewer moving parts, transactional with the queue); `dynamodb` moves polling onto
DynamoDB with native TTL. Nothing above `@atp/store` changes — flip the environment
variable and redeploy. The `Data` stack always provisions the DynamoDB tables, so the
switch needs no infrastructure change.

### Isolated runs (mode 2)

With `-c enableRunTask=true`, a submission flagged `isolated: true` (on `run_suite` /
`run_selection`) *also* launches a one-off Fargate task for that run. Use it for very long or
memory-hungry runs that would otherwise monopolise a pooled worker.

The launched task gets `MODE=worker`, `WORKER_ONCE=true`, and `ATP_RUN_ID=<runId>`, which
`workerOptionsFromConfig` turns into `maxRuns: 1` plus a **targeted** claim — it takes that
run's job specifically, not the queue head, then exits. If a pooled worker claimed the run
first, the one-off task finds nothing, waits `WORKER_IDLE_TIMEOUT_MS` (default 60s) and exits
rather than idling as billable capacity.

It is an optimisation, never a separate path: the job is enqueued **first**, so a throttled
or capacity-starved launch degrades to "the pool picks it up".

## Routine deploys

```bash
docker build -t "$REPO:$TAG" . && docker push "$REPO:$TAG"
# run MODE=migrate first if this release adds a migration
cd infra && pnpm exec cdk deploy Atp-prod-Ecs -c env=prod -c imageUri="$REPO:$TAG"
```

Both services deploy with a circuit breaker (`rollback: true`) and `minHealthyPercent: 100`,
so a failing task set rolls back automatically and capacity never dips mid-deploy. The
server drains via ALB deregistration (30s); the worker gets `stopTimeout: 120s` after
SIGTERM, and `tini` forwards the signal so the in-flight run finishes and its job lease is
released rather than abandoned.

**The worker's drain is unbounded by design** — SIGTERM stops it claiming *new* work and then
waits for the current run to finish naturally; it does not abort the in-flight HTTP request
(only a cancel request does that). So `stopTimeout` must exceed your longest expected run, or
ECS will SIGKILL mid-run. A killed run isn't lost — its lease expires and the reaper requeues
it — but it does re-execute from the start. Raise `stopTimeout` if your suites run long.

## Rollback

```bash
cd infra && pnpm exec cdk deploy Atp-prod-Ecs -c env=prod -c imageUri="$REPO:<previous-tag>"
```

Migrations are **not** rolled back automatically — they are written to be additive, so the
previous image keeps working against the newer schema. If a release needs a destructive
migration, split it: deploy the additive half, ship the code, then remove the old column in a
later release.

`cdk deploy` rolls the CloudFormation stack back on failure by default. For a stack stuck in
`UPDATE_ROLLBACK_FAILED`, use `aws cloudformation continue-update-rollback`.

## Teardown

```bash
cd infra && pnpm exec cdk destroy --all -c env=dev
```

In `prod` the database, tables, and artifact bucket carry `RemovalPolicy.RETAIN` and
deletion protection, so they survive a stack delete and must be removed deliberately.

## Operational notes

- **Alarms → what to check.** `QueueDepthHigh`: worker service healthy? scaled? Postgres
  reachable? · `RunDurationP95High`: SUT latency, or a polling step that stopped settling ·
  `PassRateLow`: usually auth or an environment/SUT outage, not N simultaneous regressions ·
  `WorkerErrors`: worker logs, filtered by `runId`.
- **Telemetry requires a collector — read this before relying on the alarms.** The app
  exports OTLP only (`OTEL_EXPORTER=otlp`, pointed at `otlpEndpoint`). **This repo's CDK does
  not provision a collector.** Until you run one that translates OTLP into CloudWatch
  `PutMetricData` under namespace `ATP`, preserving the metric names in `infra/src/metrics.ts`
  and the `status` dimension on `runs_total`, **no metric reaches CloudWatch** — which means
  the dashboard is blank, every alarm sits in `INSUFFICIENT_DATA`, and the worker service's
  `queue_depth` step-scaling never fires (workers stay pinned at `desiredCount`). Run an ADOT
  collector sidecar (or a central gateway) as part of your rollout.
- **Tracing.** With `otlpEndpoint` set and a collector running, one trace covers agent →
  server → worker → SUT: the `traceparent` travels in the job spec across the enqueue→claim
  process hop.
- **Task-row GC.** The worker sweeps expired task rows every 5 minutes (SEP-1686 result
  retention); on DynamoDB the table's native TTL reaps in parallel.
- **Costs to watch.** NAT gateway data processing (SUT egress), RDS Multi-AZ, and S3
  storage after the IA transition. DynamoDB is on-demand and tracks run volume.
