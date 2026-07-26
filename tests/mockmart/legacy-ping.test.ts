import { defineTest } from "@atp/engine";

import { mockmartLegacyAuth } from "../_shared/auth/mockmart-legacy";
import { mockmart } from "../_shared/env/mockmart";

/**
 * Migrated from Insomnia `req_legacy_ping`, whose `basic` auth block `atp import` leaves as
 * a TODO. Also the corpus's only non-JSON response: the engine parses by content-type, so
 * `body` here is the raw `text/plain` string rather than an object.
 */
export default defineTest({
  id: "mockmart.legacy-ping",
  version: 1,
  title: "Legacy endpoint answers a basic-auth caller in plain text",
  tags: ["mockmart", "legacy"],
  owner: "team-mockmart",
  timeoutMs: 10_000,
  env: mockmart,
  auth: [mockmartLegacyAuth],
  steps: [
    {
      id: "legacy-ping",
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/legacy/ping",
        authRef: "mockmart-legacy",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body", op: "eq", value: "pong" },
        { path: "headers.content-type", op: "contains", value: "text/plain" },
      ],
    },
  ],
});
