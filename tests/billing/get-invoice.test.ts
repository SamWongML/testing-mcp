import { defineTest } from "@atp/engine";

import { local } from "../_shared/env/local";

/** A standalone billing test (folder == tag == ownership). */
export default defineTest({
  id: "billing.get-invoice",
  version: 1,
  title: "Fetch an invoice by id",
  tags: ["billing"],
  owner: "team-billing",
  timeoutMs: 10_000,
  env: local,
  params: (z) => z.object({ invoiceId: z.string().default("inv-001") }),
  steps: [
    {
      id: "get-invoice",
      request: { method: "GET", url: "{{env.baseUrl}}/invoices/{{params.invoiceId}}" },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.status", op: "eq", value: "paid" },
        { path: "body.amount", op: "isNumber" },
      ],
      extract: [{ as: "amount", from: "body.amount" }],
    },
  ],
});
