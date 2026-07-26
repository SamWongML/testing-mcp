import { defineTest } from "@atp/engine";

import { fixture } from "../_shared/env/fixture";

export default defineTest({
  id: "alpha.create-widget",
  version: 1,
  title: "Creating a widget returns its id",
  tags: ["alpha", "smoke"],
  owner: "team-alpha",
  env: fixture,
  params: (z) =>
    z.object({
      sku: z.string().default("SKU-1"),
      // Secret-shaped on purpose: the audit-redaction test needs an entry that really
      // declares one, so it covers the live leak path rather than a hypothetical key.
      password: z.string().default("fixture-password"),
    }),
  steps: [
    {
      id: "create",
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/orders",
        headers: { "content-type": "application/json" },
        body: { sku: "{{params.sku}}", password: "{{params.password}}" },
      },
      assert: [
        { path: "status", op: "eq", value: 201 },
        { path: "body.orderId", op: "isString" },
        { path: "body.paymentId", op: "isString" },
      ],
      extract: [{ as: "paymentId", from: "body.paymentId" }],
    },
  ],
});
