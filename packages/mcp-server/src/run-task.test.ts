import { RunTaskCommand } from "@aws-sdk/client-ecs";
import { describe, expect, it } from "vitest";

import { createEcsRunTaskLauncher, type EcsLike } from "./run-task";

/** A stand-in for the ECS client that records what it was asked to launch. */
function fakeEcs(response: unknown = { tasks: [{ taskArn: "arn:aws:ecs:::task/abc" }] }): {
  client: EcsLike;
  sent: RunTaskCommand[];
} {
  const sent: RunTaskCommand[] = [];
  return {
    sent,
    client: {
      send: async (command: RunTaskCommand) => {
        sent.push(command);
        return response;
      },
    } as EcsLike,
  };
}

const options = {
  cluster: "atp-prod",
  taskDefinition: "atp-worker:7",
  subnets: ["subnet-a", "subnet-b"],
  securityGroups: ["sg-1"],
  containerName: "worker",
};

describe("createEcsRunTaskLauncher", () => {
  it("launches a one-shot Fargate worker for a single run (§11.3 mode 2)", async () => {
    const { client, sent } = fakeEcs();
    const launcher = createEcsRunTaskLauncher({ client, ...options });

    const arn = await launcher.launch("run-123");
    expect(arn).toBe("arn:aws:ecs:::task/abc");

    const input = sent[0]!.input;
    expect(input.cluster).toBe("atp-prod");
    expect(input.taskDefinition).toBe("atp-worker:7");
    expect(input.launchType).toBe("FARGATE");
    expect(input.networkConfiguration?.awsvpcConfiguration).toMatchObject({
      subnets: ["subnet-a", "subnet-b"],
      securityGroups: ["sg-1"],
      // Private subnets reach AWS through the NAT/gateway endpoints, never a public IP.
      assignPublicIp: "DISABLED",
    });

    const override = input.overrides?.containerOverrides?.[0];
    expect(override?.name).toBe("worker");
    const env = new Map((override?.environment ?? []).map((e) => [e.name, e.value]));
    // The launched task must drain exactly one job and exit, or it becomes a second,
    // unmanaged worker pool that never scales in.
    expect(env.get("MODE")).toBe("worker");
    expect(env.get("WORKER_ONCE")).toBe("true");
    // Correlates the one-off task's logs with the run it was launched for.
    expect(env.get("ATP_RUN_ID")).toBe("run-123");
  });

  it("surfaces an ECS failure instead of reporting a launch that did not happen", async () => {
    const { client } = fakeEcs({
      tasks: [],
      failures: [{ arn: "x", reason: "RESOURCE:MEMORY" }],
    });
    const launcher = createEcsRunTaskLauncher({ client, ...options });

    // The durable job is still queued, so the pool remains the backstop — but the caller
    // must not be told an isolated task is running when none is.
    await expect(launcher.launch("run-123")).rejects.toThrow(/RESOURCE:MEMORY/);
  });
});
