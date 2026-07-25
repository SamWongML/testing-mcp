import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTaskStoreProvider, listRuns, type StoreClient } from "@atp/store";
import { dynamoAvailable, makeTestTables, TEST_AWS_ENV, type TestTables } from "@atp/store/testing";
import { loadConfig } from "@atp/schema";

import type { ServerContext } from "./context";
import { getRun, getRunResult, submitRun } from "./tasks";
import { makeTestContext, makeTestDb, pgAvailable, startTestSut, type TestSut } from "./testkit";
import { claimAndRun } from "./worker";

/**
 * P11 store selection (plan exit criterion 3): the *same* async surface, with hot task state
 * on DynamoDB instead of Postgres. Nothing in `tasks.ts`/`worker.ts` is dynamo-aware — the
 * only difference from `async-lifecycle.test.ts` is the `taskStore` provider on the context.
 * Needs both backing services, so it gates on both env vars.
 */
describe.skipIf(!pgAvailable || !dynamoAvailable)("async lifecycle on DynamoDB task state", () => {
  let store: StoreClient;
  let tables: TestTables;
  let ctx: ServerContext;
  let sut: TestSut;

  beforeEach(async () => {
    store = await makeTestDb();
    tables = await makeTestTables();
    sut = await startTestSut();
    // The provider builds its own SDK client from config, so credentials come from the
    // standard AWS chain — an ECS task role in production, these dummies against local.
    Object.assign(process.env, TEST_AWS_ENV);
    const config = loadConfig({
      TASK_STORE: "dynamodb",
      DYNAMO_TASKS_TABLE: tables.tasksTable,
      DYNAMO_IDEMPOTENCY_TABLE: tables.idempotencyTable,
      DYNAMO_ENDPOINT: process.env.ATP_TEST_DYNAMO_ENDPOINT,
    });
    ctx = await makeTestContext({ db: store.db, taskStore: createTaskStoreProvider(config) });
  });
  afterEach(async () => {
    ctx.taskStore?.close();
    await sut.close();
    await tables.close();
    await store.close();
  });

  it("submit → worker → completed, with task state served from DynamoDB", async () => {
    const { runId, state } = await submitRun(ctx, {
      entryId: "billing.e2e-refund",
      env: { baseUrl: sut.url },
    });
    expect(state).toBe("working");

    // The working task item is in Dynamo, not Postgres — read it through the raw store to
    // prove the surface is not quietly still using the `tasks` table.
    expect(await tables.taskItem(runId)).toMatchObject({ state: "working" });

    expect(await claimAndRun(ctx, "worker-1")).toBe(true);

    const task = await getRun(ctx, runId);
    expect(task?.state).toBe("completed");
    expect(task?.progressPct).toBe(100);

    const result = await getRunResult(ctx, runId);
    expect(result.ready).toBe(true);
    expect(result.result?.status).toBe("passed");

    // The system of record is still Postgres (ADR-005: record in pg, poll in Dynamo).
    expect((await listRuns(store.db, {})).map((r) => r.id)).toContain(runId);
  });

  it("dedupes a resubmitted idempotency key via the idempotency table", async () => {
    const key = "nightly-smoke";
    const first = await submitRun(ctx, {
      entryId: "identity.login",
      env: { baseUrl: sut.url },
      idempotencyKey: key,
    });
    const second = await submitRun(ctx, {
      entryId: "identity.login",
      env: { baseUrl: sut.url },
      idempotencyKey: key,
    });

    expect(second.runId).toBe(first.runId);
    expect(second.deduped).toBe(true);
    // With a dedicated idempotency table the run id is minted independently of the key —
    // the stage-1 Postgres path had to make the key *be* the run id.
    expect(first.runId).not.toBe(key);

    // One job enqueued, so the second submission cannot double-execute.
    expect(await claimAndRun(ctx, "worker-1")).toBe(true);
    expect(await claimAndRun(ctx, "worker-1")).toBe(false);
  });
});
