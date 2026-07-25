import { ECSClient, RunTaskCommand, type RunTaskCommandOutput } from "@aws-sdk/client-ecs";

/**
 * The §11.3 **mode 2** escape hatch: instead of waiting for the shared worker pool, the
 * server launches a one-off Fargate task that executes a single run and exits. That buys
 * strong isolation and per-run resource limits for the very long / very heavy runs that
 * would otherwise monopolise a pooled worker (the noisy-neighbour case).
 *
 * It is *additive to* the durable queue, never a replacement: the job is already enqueued
 * before a launch is attempted, so a `RunTask` throttle or capacity failure degrades to
 * "the pool picks it up a bit later" rather than a lost run. Mode 1 stays the default.
 */

/** The slice of the ECS client this uses — narrow so tests can substitute a recorder. */
export interface EcsLike {
  send(command: RunTaskCommand): Promise<RunTaskCommandOutput>;
}

export interface EcsRunTaskLauncherOptions {
  client?: EcsLike;
  cluster: string;
  /** Task definition family[:revision] of the worker task. */
  taskDefinition: string;
  /** Private subnets the task runs in. */
  subnets: string[];
  securityGroups: string[];
  /** Container name inside the task definition to apply the environment override to. */
  containerName: string;
}

export interface RunTaskLauncher {
  /** Launch an isolated worker for `runId`; resolves to the launched task's ARN. */
  launch(runId: string): Promise<string>;
}

export function createEcsRunTaskLauncher(options: EcsRunTaskLauncherOptions): RunTaskLauncher {
  const client = options.client ?? new ECSClient({});

  return {
    async launch(runId: string): Promise<string> {
      const out = await client.send(
        new RunTaskCommand({
          cluster: options.cluster,
          taskDefinition: options.taskDefinition,
          launchType: "FARGATE",
          count: 1,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: options.subnets,
              securityGroups: options.securityGroups,
              // Private subnets egress via NAT and the gateway endpoints (§17.2).
              assignPublicIp: "DISABLED",
            },
          },
          overrides: {
            containerOverrides: [
              {
                name: options.containerName,
                environment: [
                  { name: "MODE", value: "worker" },
                  // One job, then exit — otherwise this becomes a second worker pool with
                  // no autoscaling and no scale-in.
                  { name: "WORKER_ONCE", value: "true" },
                  { name: "ATP_RUN_ID", value: runId },
                ],
              },
            ],
          },
          // Makes the one-off task findable in the console/logs by the run it serves.
          tags: [
            { key: "atp:run_id", value: runId },
            { key: "atp:mode", value: "run-task" },
          ],
        }),
      );

      const failure = out.failures?.[0];
      if (failure) {
        throw new Error(
          `ecs:RunTask failed for run ${runId}: ${failure.reason ?? "unknown"}${
            failure.detail ? ` (${failure.detail})` : ""
          }`,
        );
      }
      const arn = out.tasks?.[0]?.taskArn;
      if (!arn) throw new Error(`ecs:RunTask returned no task for run ${runId}`);
      return arn;
    },
  };
}
