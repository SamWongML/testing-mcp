import { defineTest } from "@atp/engine";

import { mockmart } from "../_shared/env/mockmart";

/**
 * Migrated from Insomnia `req_slow`. The point of this one is the per-step `timeoutMs`:
 * the endpoint sleeps for the requested duration, so the step budget is what decides
 * whether a slow dependency reads as a pass or as a timeout.
 */
export default defineTest({
  id: "mockmart.slow-endpoint",
  version: 1,
  title: "A slow endpoint answers inside its step budget",
  tags: ["mockmart", "latency"],
  owner: "team-mockmart",
  timeoutMs: 20_000,
  env: mockmart,
  // Query values are strings by contract (`RequestSpec.query`), and a whole-value template
  // preserves the param's type — so this param is a string, not a number.
  params: (z) =>
    z.object({
      sleepMs: z
        .string()
        .regex(/^\d{1,4}$/)
        .default("250"),
    }),
  steps: [
    {
      id: "slow-endpoint",
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/slow",
        query: { ms: "{{params.sleepMs}}" },
      },
      // Bounds this send only; the entry-level timeoutMs is the fallback for steps
      // that don't set one.
      timeoutMs: 5_000,
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.status", op: "eq", value: "ok" },
        { path: "body.sleptMs", op: "isNumber" },
        { path: "body.sleptMs", op: "lt", value: 5_000 },
      ],
    },
  ],
});
