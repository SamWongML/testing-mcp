import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { S3ArtifactStore } from "./s3-artifacts";
import { makeTestBucket, s3Available, type TestBucket } from "./test-aws";

describe.skipIf(!s3Available)("S3ArtifactStore", () => {
  let bucket: TestBucket;
  let store: S3ArtifactStore;
  beforeEach(async () => {
    bucket = await makeTestBucket();
    store = new S3ArtifactStore({ client: bucket.client, bucket: bucket.bucket });
  });
  afterEach(async () => {
    await bucket.close();
  });

  it("round-trips an artifact through put/get", async () => {
    const body = JSON.stringify({ runId: "r1", status: "passed" });
    const put = await store.put("mcp/2026/07/25/r1/trace.json", body, "application/json");

    expect(put.key).toBe("mcp/2026/07/25/r1/trace.json");
    expect(put.uri).toBe(`s3://${bucket.bucket}/mcp/2026/07/25/r1/trace.json`);
    expect((await store.get("mcp/2026/07/25/r1/trace.json")).toString("utf8")).toBe(body);
  });

  it("presigns a URL an unauthenticated client can fetch", async () => {
    await store.put("mcp/2026/07/25/r1/report.md", "# Report\n", "text/markdown");
    const url = await store.presign("mcp/2026/07/25/r1/report.md", 60);

    // The point of presigning is that the holder needs no AWS credentials — so fetch it
    // with a plain HTTP client, the way an agent following `get_report` would.
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Report\n");
  });
});
