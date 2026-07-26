import { describe, expect, it } from "vitest";

import { loadConfig } from "@atp/schema";

import { PostgresTaskStore } from "../tasks";
import { DynamoTaskStore } from "./dynamo-tasks";
import { createTaskStoreProvider } from "./select";

/** Build a validated config from a partial env, so these assert against the real schema. */
const config = (env: Record<string, string>) => loadConfig({ ...env });

describe("createTaskStoreProvider", () => {
  it("defaults to the Postgres task store (the stage-1 collapse)", () => {
    const provider = createTaskStoreProvider(config({}));
    // `null` stands in for the Db/transaction handle — selection must not touch it.
    expect(provider.forDb(null as never)).toBeInstanceOf(PostgresTaskStore);
    expect(provider.idempotency).toBeUndefined();
  });

  it("selects the DynamoDB task store when configured", () => {
    const provider = createTaskStoreProvider(
      config({
        TASK_STORE: "dynamodb",
        DYNAMO_TASKS_TABLE: "atp-tasks",
        DYNAMO_IDEMPOTENCY_TABLE: "atp-idempotency",
        DYNAMO_ENDPOINT: "http://localhost:8000",
      }),
    );
    // The same call site that yields Postgres above now yields Dynamo — the switch is
    // config, and the caller passes its transaction handle either way.
    expect(provider.forDb(null as never)).toBeInstanceOf(DynamoTaskStore);
    expect(provider.idempotency).toBeDefined();
    provider.close();
  });

  it("fails fast when DynamoDB is selected without a table name", () => {
    expect(() => createTaskStoreProvider(config({ TASK_STORE: "dynamodb" }))).toThrow(
      /DYNAMO_TASKS_TABLE/,
    );
  });
});
