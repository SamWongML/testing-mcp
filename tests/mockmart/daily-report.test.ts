import { defineTest } from "@atp/engine";

import { mockmartReportingAuth } from "../_shared/auth/mockmart-reporting";
import { mockmart } from "../_shared/env/mockmart";

/**
 * Migrated from Insomnia `req_daily_report`. Its `oauth2` block became a declarative
 * client-credentials provider: the engine fetches the token from the SUT's token endpoint
 * on first use and caches it for the rest of the run.
 */
export default defineTest({
  id: "mockmart.daily-report",
  version: 1,
  title: "Daily revenue report is readable with a client-credentials token",
  tags: ["mockmart", "reporting"],
  owner: "team-mockmart",
  timeoutMs: 15_000,
  env: mockmart,
  auth: [mockmartReportingAuth],
  steps: [
    {
      id: "daily-report",
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/reports/daily",
        authRef: "mockmart-reporting",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.date", op: "matches", value: "^\\d{4}-\\d{2}-\\d{2}$" },
        { path: "body.orders", op: "gt", value: 0 },
        { path: "body.revenueCents", op: "isNumber" },
        { path: "body.currency", op: "eq", value: "usd" },
        {
          fn: (res) => {
            const body = (res as { body: { orders: number; revenueCents: number } }).body;
            return body.revenueCents / body.orders > 100;
          },
          message: "average order value must exceed $1",
        },
      ],
    },
  ],
});
