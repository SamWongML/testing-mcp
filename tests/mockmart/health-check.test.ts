import { defineTest } from "@atp/engine";

import { mockmart } from "../_shared/env/mockmart";

/**
 * Migrated from Insomnia `req_health`. The `head-health` step is an addition, not parity:
 * the collection had no HEAD request, and a bodiless response is worth covering.
 */
export default defineTest({
  id: "mockmart.health-check",
  version: 1,
  title: "Service reports healthy over GET and HEAD",
  tags: ["mockmart", "smoke"],
  owner: "team-mockmart",
  timeoutMs: 10_000,
  env: mockmart,
  params: (z) => z.object({ region: z.string().default("us") }),
  steps: [
    {
      id: "health-check",
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/health",
        // `query` is a first-class field, so the region stays addressable rather than
        // being spliced into the url string.
        query: { region: "{{params.region}}" },
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.status", op: "eq", value: "ok" },
        { path: "body.checks.db", op: "eq", value: "ok" },
        { path: "body.version", op: "matches", value: "^\\d+\\.\\d+\\.\\d+$" },
        { path: "headers.content-type", op: "contains", value: "application/json" },
        {
          path: "body",
          op: "jsonSchema",
          value: {
            type: "object",
            required: ["status", "version", "checks"],
            properties: {
              status: { type: "string", enum: ["ok", "degraded"] },
              version: { type: "string" },
              checks: {
                type: "object",
                required: ["db", "queue"],
                properties: { db: { type: "string" }, queue: { type: "string" } },
              },
            },
          },
          message: "health payload shape",
        },
      ],
      extract: [{ as: "version", from: "body.version" }],
      retry: { max: 2, backoffMs: 200, on: ["network", "5xx"] },
    },
    {
      id: "head-health",
      request: { method: "HEAD", url: "{{env.baseUrl}}/health" },
      // A HEAD response has no body to assert on, so the pin is the status plus a header.
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "headers.x-sut", op: "eq", value: "mockmart" },
      ],
    },
  ],
});
