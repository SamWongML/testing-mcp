import { defineTest } from "@atp/engine";

import { mockmart_api_tokenAuth } from "../_shared/auth/mockmart-api-token";
import { mockmart } from "../_shared/env/mockmart";

/**
 * Migrated from Insomnia `req_inventory`. The endpoint 503s twice per sku while it warms
 * up, so this is the corpus's transport-retry case: `on: ["5xx"]` re-sends the request,
 * and the run reports the attempt count it needed.
 */
export default defineTest({
  id: "mockmart.inventory-lookup",
  version: 1,
  title: "Inventory is readable once the warehouse warms up",
  tags: ["mockmart", "inventory"],
  owner: "team-mockmart",
  timeoutMs: 15_000,
  env: mockmart,
  auth: [mockmart_api_tokenAuth],
  params: (z) => z.object({ sku: z.string().default("sku-1001") }),
  steps: [
    {
      id: "inventory-lookup",
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/inventory/{{params.sku}}",
        authRef: "mockmart-api-token",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.available", op: "isNumber" },
        { path: "body.available", op: "gt", value: 0 },
        { path: "body.reserved", op: "lt", value: 10 },
        { path: "body.warehouse", op: "eq", value: "eu-west-1" },
        { path: "body.sku", op: "isString" },
      ],
      extract: [{ as: "available", from: "body.available" }],
      // Transport retry only: the assertion axis belongs to `poll` (see the checkout suite).
      retry: { max: 3, backoffMs: 150, on: ["5xx", "network"] },
    },
  ],
});
