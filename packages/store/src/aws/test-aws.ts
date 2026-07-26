import { randomUUID } from "node:crypto";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { CreateBucketCommand, DeleteBucketCommand, S3Client } from "@aws-sdk/client-s3";

import { createDocumentClient } from "./client";
import { IDEM_KEY_ATTR, TASK_KEY_ATTR } from "./attributes";

/**
 * Integration-test harness for the AWS adapters, mirroring `db/test-db.ts`: the backing
 * service is provided out-of-band (dynamodb-local / MinIO from `docker-compose.dev.yml`,
 * or a CI service container) and the suites `describe.skipIf` out when its endpoint env
 * var is unset — so `pnpm test` stays green with nothing running.
 *
 * Each `makeTestTables()` / `makeTestBucket()` creates throwaway, uniquely-named resources
 * and drops them on `close()`, so suites are isolated over one shared server.
 */

export const TEST_DYNAMO_ENDPOINT = process.env.ATP_TEST_DYNAMO_ENDPOINT;
export const dynamoAvailable = Boolean(TEST_DYNAMO_ENDPOINT);

export const TEST_S3_ENDPOINT = process.env.ATP_TEST_S3_ENDPOINT;
export const s3Available = Boolean(TEST_S3_ENDPOINT);

/** dynamodb-local and MinIO validate the signature shape, not the credentials themselves. */
const TEST_CREDENTIALS = { accessKeyId: "atp", secretAccessKey: "atpsecret" };
const TEST_REGION = "us-east-1";

export interface TestTables {
  client: DynamoDBDocumentClient;
  tasksTable: string;
  idempotencyTable: string;
  /** Raw item read, bypassing `DynamoTaskStore` — lets a test prove state really landed
   * in DynamoDB rather than trusting the adapter it is exercising. */
  taskItem: (runId: string) => Promise<Record<string, unknown> | null>;
  /** Raw scan of the tasks table, for assertions where the runId isn't known up front. */
  scanTasks: () => Promise<Record<string, unknown>[]>;
  close: () => Promise<void>;
}

/**
 * The dummy credentials dynamodb-local/MinIO expect. The adapters resolve credentials
 * through the standard AWS chain (an ECS task role in production), so a test that builds a
 * store from *config* rather than from an explicit client needs these in the environment.
 */
export const TEST_AWS_ENV = {
  AWS_ACCESS_KEY_ID: TEST_CREDENTIALS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: TEST_CREDENTIALS.secretAccessKey,
  AWS_REGION: TEST_REGION,
} as const;

async function createKeyedTable(raw: DynamoDBClient, name: string, key: string): Promise<void> {
  await raw.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [{ AttributeName: key, AttributeType: "S" }],
      KeySchema: [{ AttributeName: key, KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  await waitUntilTableExists({ client: raw, maxWaitTime: 30 }, { TableName: name });
}

/** A private pair of `tasks` + `idempotency` tables for one suite. */
export async function makeTestTables(): Promise<TestTables> {
  const endpoint = TEST_DYNAMO_ENDPOINT;
  if (!endpoint) throw new Error("ATP_TEST_DYNAMO_ENDPOINT is not set");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const tasksTable = `atp_test_tasks_${suffix}`;
  const idempotencyTable = `atp_test_idem_${suffix}`;

  const raw = new DynamoDBClient({
    endpoint,
    region: TEST_REGION,
    credentials: TEST_CREDENTIALS,
  });
  await createKeyedTable(raw, tasksTable, TASK_KEY_ATTR);
  await createKeyedTable(raw, idempotencyTable, IDEM_KEY_ATTR);

  const client = createDocumentClient({
    endpoint,
    region: TEST_REGION,
    credentials: TEST_CREDENTIALS,
  });

  return {
    client,
    tasksTable,
    idempotencyTable,
    taskItem: async (runId) => {
      const { Item } = await client.send(
        new GetCommand({
          TableName: tasksTable,
          Key: { [TASK_KEY_ATTR]: runId },
          ConsistentRead: true,
        }),
      );
      return Item ?? null;
    },
    scanTasks: async () => {
      const { Items } = await client.send(new ScanCommand({ TableName: tasksTable }));
      return Items ?? [];
    },
    close: async () => {
      await raw.send(new DeleteTableCommand({ TableName: tasksTable }));
      await raw.send(new DeleteTableCommand({ TableName: idempotencyTable }));
      raw.destroy();
    },
  };
}

export interface TestBucket {
  client: S3Client;
  bucket: string;
  endpoint: string;
  close: () => Promise<void>;
}

/** A private, empty S3 bucket for one suite. The caller deletes the objects it wrote. */
export async function makeTestBucket(): Promise<TestBucket> {
  const endpoint = TEST_S3_ENDPOINT;
  if (!endpoint) throw new Error("ATP_TEST_S3_ENDPOINT is not set");
  const bucket = `atp-test-${randomUUID()}`;
  const client = new S3Client({
    endpoint,
    region: TEST_REGION,
    credentials: TEST_CREDENTIALS,
    // MinIO serves path-style URLs; virtual-host style would resolve to a bogus hostname.
    forcePathStyle: true,
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return {
    client,
    bucket,
    endpoint,
    close: async () => {
      await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {
        // A non-empty bucket refuses deletion; the server is throwaway, so leaking is fine.
      });
      client.destroy();
    },
  };
}
