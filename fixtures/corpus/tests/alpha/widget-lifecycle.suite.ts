import { defineSuite, useTest } from "@atp/engine";

import { fixture } from "../_shared/env/fixture";
import createWidget from "./create-widget.test";

/**
 * The fixture suite. `verify` polls until the ledger settles, which gives the async-lifecycle
 * tests a deterministic in-flight window: `startTestSut({ ledgerSettles: false })` holds this
 * node polling for as long as the test needs, so a cancel can land mid-run.
 */
export default defineSuite({
  id: "alpha.widget-lifecycle",
  version: 1,
  title: "Create a widget, capture its payment, then verify the ledger",
  tags: ["alpha", "e2e"],
  owner: "team-alpha",
  env: fixture,
  nodes: {
    create: useTest(createWidget),
    capture: {
      needs: ["create"],
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/payments/{{nodes.create.paymentId}}/capture",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.status", op: "eq", value: "captured" },
      ],
    },
    verify: {
      needs: ["capture"],
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/ledger/refunds/{{nodes.create.paymentId}}",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.status", op: "eq", value: "settled" },
      ],
      poll: { untilAssertPasses: true, intervalMs: 100, maxMs: 5_000 },
    },
  },
});
