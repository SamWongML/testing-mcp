import { defineSuite, useStep, useTest } from "@atp/engine";

import { local } from "../_shared/env/local";
import { createOrder } from "../_shared/steps/create-order";
import login from "../identity/login.test";

/**
 * A suite that composes existing tests/steps with no duplication (research §7.2). `login`
 * is reused by reference; `createOrder` is a shared step bound with the extracted token.
 * `needs` makes the DAG explicit; `extract` publishes values later nodes address via
 * `{{nodes.X.var}}`; `verify` polls until the ledger settles. `timeoutMs` > 30s marks it
 * long-running (an MCP Task by default in P8).
 */
export default defineSuite({
  id: "billing.e2e-refund",
  version: 1,
  title: "Create order → capture → refund → verify ledger",
  tags: ["billing", "e2e"],
  owner: "team-billing",
  timeoutMs: 120_000,
  env: local,
  nodes: {
    auth: useTest(login, { params: { email: "billing-bot@example.com" } }),
    order: useStep(createOrder, { needs: ["auth"], with: { token: "{{nodes.auth.authToken}}" } }),
    capture: {
      needs: ["order"],
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/payments/{{nodes.order.paymentId}}/capture",
      },
      assert: [{ path: "status", op: "eq", value: 200 }],
    },
    refund: {
      needs: ["capture"],
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/payments/{{nodes.order.paymentId}}/refund",
      },
      assert: [{ path: "status", op: "eq", value: 202 }],
      extract: [{ as: "refundId", from: "body.id" }],
    },
    verify: {
      needs: ["refund"],
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/ledger/refunds/{{nodes.refund.refundId}}",
      },
      assert: [{ path: "body.status", op: "eq", value: "settled" }],
      poll: { untilAssertPasses: true, intervalMs: 200, maxMs: 5_000 },
    },
  },
});
