import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * AWS client construction, kept in one place so the adapters take an already-built client
 * and stay free of credential/endpoint concerns. In production nothing is passed: the SDK
 * resolves the region and the ECS task role's credentials from the environment. Tests pass
 * an explicit `endpoint` (dynamodb-local) and dummy credentials.
 */

export interface AwsClientOptions {
  /** Override the service endpoint (dynamodb-local / MinIO). Unset in production. */
  endpoint?: string;
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export function createDynamoClient(options: AwsClientOptions = {}): DynamoDBClient {
  return new DynamoDBClient(options);
}

/**
 * The document client marshalls plain JS values, so the adapters never hand-build
 * `{ S: … }` attribute values. `removeUndefinedValues` lets an optional field simply be
 * omitted from an item instead of failing the marshaller.
 */
export function createDocumentClient(
  options: AwsClientOptions | DynamoDBClient = {},
): DynamoDBDocumentClient {
  const base = options instanceof DynamoDBClient ? options : createDynamoClient(options);
  return DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true },
  });
}
